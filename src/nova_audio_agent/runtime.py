"""Single event loop: routing + arbitration, nothing else (01-spine.md).

Model calls and executors never run inside the loop — they are all spawned
as tasks, and their completion becomes a new event that comes back to the
queue. So "a tool call must not block whether FastBrain gets to act" goes
from a discipline to a structural guarantee — **there is no place in the
loop body that awaits an executor**.

Anti-workflow note: apply and the wake table contain no business judgment.
If someone one day wants to write `if intent.phase == "clarifying"` in the
loop body, that is the signal that v3 is starting to regress into v2.

## The order of the three branches must not change

(1) drain runnable tasks first -> (2) then take a ready event ->
(3) only advance virtual time if neither of the above has anything.

advance_to(t) only makes the coroutines sleeping until t **ready** — they
haven't run yet. If we popped the event first, the Deadline(ts=t) that was
enqueued at dispatch time would get processed first, while the handoff that
should be posted at that very same instant hasn't entered the queue yet —
events.kind_rank can't order an event that doesn't exist yet, so the
delegate that "happened to succeed exactly at the deadline instant" gets a
spurious unknown, violating termination rule 1 in 05-executors.md.

kind_rank and this ordering are two halves of the same bug: **the ordering
makes the two events actually land on the same ts, and kind_rank decides
who goes first on that same ts.** Neither one alone is enough.
"""

from __future__ import annotations

import asyncio
import math
from collections import deque
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, fields, replace
from typing import Any

from nova_audio_agent.calls import (
    AttentionDecision,
    AttentionTrigger,
    CallRecord,
    WatchRecord,
    run_fast_brain_call,
    run_surrogate_call,
)
from nova_audio_agent.clock import Clock, RealClock, VirtualClock
from nova_audio_agent.context_view import FRESH_WINDOW, ContextView, compile_context_view
from nova_audio_agent.delegates import REJECTED_WAKE_KIND, DelegateLedger, validate_origin_ref
from nova_audio_agent.events import (
    AssistantSpoken,
    Compress,
    CompressDone,
    Deadline,
    Event,
    EventQueue,
    HandoffEvent,
    ModelDone,
    ObservationEvent,
    ProgressEvent,
    RoutingClass,
    SpeakEnd,
    SpeakStart,
    UserInput,
    WakeReason,
)
from nova_audio_agent.floor import Floor
from nova_audio_agent.memory import (
    CONVERSATION_CHANNEL,
    USER_PRIORITY,
    HandoffPolicy,
    Memory,
    MemoryItem,
    MemoryRef,
    Outcome,
    Trust,
    parse_ref,
)
from nova_audio_agent.ports import (
    Compressor,
    Delegate,
    DelegateRequest,
    DispatchContext,
    ExecutorAdapter,
    FastBrain,
    Handoff,
    ObservationPayload,
    ProgressPayload,
    Surrogate,
    UpdateSpec,
    bind_delegate,
    valid_progress_summary,
)
from nova_audio_agent.slots import Slot, SlotSet
from nova_audio_agent.speech import RecordingSink, SpeechSink
from nova_audio_agent.suggestions import (
    DEFAULT_COOLDOWN,
    SELECTED_WAKE_KIND,
    Suggestion,
    SuggestionPool,
    is_available,
)
from nova_audio_agent.trace import TraceWriter

MakeEvent = Callable[[str, Any], Event]
EventObserver = Callable[[Event], None]

# Three slots, split by call, not by backend (R1). watch and compress may land
# on the same backend model, but they have different signatures and different
# trigger sources — sharing one slot would make "compress arriving while watch
# is in-flight" get dropped outright.
SLOT_FAST = "fast"
SLOT_WATCH = "surrogate.watch"
SLOT_COMPRESS = "compress"

# The three values of `HandoffPolicy.wake` -> slot. **It only gets a say in the
# "externally-observed, nobody summoned it" cell** — the result of work we
# dispatched ourselves goes through `_result_slot` (R44).
_POLICY_SLOT: dict[str, Slot | None] = {
    "fast": SLOT_FAST,
    "surrogate": SLOT_WATCH,
    "none": None,
}

WakeTargets = tuple[tuple[str, WakeReason], ...]

# The three landing spots `ActAct=update` recognizes. The `Literal` on
# `UpdateSpec.target` is only for the type checker — at runtime it stops
# nothing at all, the model can hand back whatever it wants, so this table
# has to actually exist at runtime (R41).
_UPDATE_TARGETS = ("intent", "goal", "authorization")
_REDACTED_PARAM = "[REDACTED]"


@dataclass(frozen=True, slots=True)
class _CompressionRecord:
    channel: str
    snapshot_count: int


@dataclass(frozen=True, slots=True)
class _CompressionResult:
    summary: str | None
    error_type: str | None = None


@dataclass(frozen=True, slots=True)
class RuntimeDispatchResult:
    accepted: bool
    delegate_id: str | None = None
    problem: str | None = None


async def _compress_guarded(
    compressor: Compressor,
    items: Sequence[MemoryItem],
) -> _CompressionResult:
    try:
        summary = (await compressor.compress(items)).strip()
    except Exception as exc:
        return _CompressionResult(summary=None, error_type=type(exc).__name__)
    return _CompressionResult(summary=summary or None)


def _shaped_like(current: Any, value: Any) -> bool:
    """Can `value` be put into this field? **Use the current value as the mold**,
    don't read the annotation.

    Every field on the three structs has a non-None default, so the type of the
    current value already is that field's shape — going further to
    `get_type_hints` + tearing apart `get_origin`/`get_args` would be dragging
    a miniature type checker into the spine, and all the extra it could
    recognize is the value layer of `Literal`, which we've explicitly said we
    don't handle.

    `bool` has to be blocked out of the numeric branch on its own: in Python
    `isinstance(True, int)` is true, so `uncertainty=True` would sail straight
    through and get rendered into the view as-is.
    """
    if isinstance(current, bool):
        return isinstance(value, bool)
    if isinstance(current, str):
        return isinstance(value, str)
    if isinstance(current, tuple):
        # list is the only form the model's half of the JSON can write; accept
        # it and normalize to tuple. Verify each element: `[["nested"]]` would
        # otherwise slip in, leaving a mutable hole inside a frozen shell.
        return isinstance(value, list | tuple) and all(isinstance(item, str) for item in value)
    if isinstance(current, int | float):
        return isinstance(value, int | float) and not isinstance(value, bool)
    return False


def wake_targets(
    event: Event, memory: Memory, *, ledger: DelegateLedger | None = None
) -> WakeTargets:
    """Event -> which slots it should wake. **Table lookup, no business
    judgment** (01-spine.md event table).

    Neither the wake targets nor the priority look at event.content: text
    returned by an executor lives permanently in memory and gets injected into
    context over and over — it must not be able to direct the spine on top of
    that. Priority is decided by the triggering event; the model cannot
    self-escalate.

    `ledger` can be omitted so that the eight call sites for "events unrelated
    to delegates" keep calling with two arguments as before — they are a
    line-by-line copy of the event table, and changing the signature along
    with them would drag the whole mutation ledger through a rerun too.
    When omitted, **a fresh empty one is built on the spot**, not shared from
    a module-level singleton: that kind of singleton is mutable, and putting
    it on a default argument would put it on the public API — anyone who
    dispatches into it would cross-contaminate the ledger across Runtimes.
    """
    return _WAKE[event.KIND](event, memory, ledger if ledger is not None else DelegateLedger())


def _result_slot(routing_class: RoutingClass, policy: HandoffPolicy) -> Slot:
    """Who should wake up for the result of work we dispatched ourselves (R44).

    Two cells, split by "is anyone waiting":

        user_awaited -> always SLOT_FAST, `policy.wake` has no veto
        ambient      -> follows `policy.wake`, but falls back to the
                         Surrogate decision slot

    The first cell is the last leg of "if work was dispatched, there must be a
    then." `policy.wake` is a **channel-level** static config; it states "what
    this channel's activity should generally reach." Whereas "the user is
    waiting on this one right now" is a fact at the **causal-chain level**.
    Letting the static config override the causal fact would let a channel
    with `wake="none"` / `wake="surrogate"` silently swallow an answer the
    user is waiting for — the user asked something, and then there was no
    then.

    The asymmetry the other way is intentional: the `ambient` cell still
    follows channel policy, because at that point nobody really is waiting.
    A Surrogate call may re-evaluate suggestions already in the pool against
    the new observation; it cannot create a suggestion from the result. So
    this rule only blocks the downgrade direction, not the upgrade direction.

    **The return value has no `None` slot**, which is the direct corollary of
    the third contract: work we dispatched with our own hands must always
    have somewhere for its result to go, no matter what. Dispatching work on
    a channel with `wake="none"` and having it time out would, read literally,
    mean "write an `unknown` into memory, then wake nobody" — which is exactly
    the "work was dispatched, and then there was no then" that this book is
    meant to block, just this time it's the spine itself that produced it.
    So `none` falls back to `SLOT_WATCH` in this cell. That watch may
    legitimately end silently when no suggestion is offered; the result
    remains stored on its channel. No executor today declares
    `wake="none"` (that value is only used by the conversation channel, and
    the conversation channel has no handoff), so this branch is unreachable
    for now; it stays because it's a door a manifest alone can open.

    **Externally-observed events (the ones the ledger can't find a parent
    for) don't go through here** — they're entirely governed by `policy.wake`,
    without even the `none` fallback; see `_wake_handoff`. So that field
    actually governs **two cells** — this `ambient` plus externally-observed
    events — not just the externally-observed one (codex review correction).
    """
    if routing_class == "user_awaited":
        return SLOT_FAST
    return _POLICY_SLOT[policy.wake] or SLOT_WATCH


def _wake_user_input(event: UserInput, memory: Memory, ledger: DelegateLedger) -> WakeTargets:
    """Wake FastBrain directly, bypassing the Surrogate; the root of the chain
    is user input -> user_awaited (R12)."""
    return (
        (
            SLOT_FAST,
            WakeReason(kind=event.KIND, priority=USER_PRIORITY, routing_class="user_awaited"),
        ),
    )


def _wake_handoff(event: HandoffEvent, memory: Memory, ledger: DelegateLedger) -> WakeTargets:
    """Route by **the routing class bound when that delegate was dispatched**;
    only the ones with no parent found fall back to channel policy.

    Routing class is not derived from HandoffPolicy: that's exactly the
    counterexample at 05-executors.md line 105 — the user asks something ->
    a search gets dispatched -> search's handoff dispatches another query,
    and if the second hop were computed from channel policy it would become
    ambient, and the user's original question would never get a then again.
    Priority still comes from policy (it's "how urgent this channel is,"
    unrelated to the causal chain).

    **The line between the two cells is "does the ledger recognize this
    delegate's parent" (R44)**:
    - recognized -> this is the result of work we dispatched, goes through
      `_result_slot`, and the `user_awaited` path must not be vetoed by
      `policy.wake`;
    - not recognized -> this is an externally-observed event nobody summoned
      (today only the ambient channel in tests; its real shape awaits the
      first push-style executor). There's no causal chain to inherit here,
      so `policy.wake` is the only source of information, and that's
      genuinely correct.
    """
    policy = memory.policies[event.channel]
    delegate = ledger.find(event.delegate_id)
    if delegate is None:
        # Externally-observed: no causal chain, `policy.wake` is the only
        # source of information, and `none` really does mean wake nobody.
        slot = _POLICY_SLOT[policy.wake]
        if slot is None:
            return ()
        routing_class: RoutingClass = "ambient"
    else:
        routing_class = delegate.routing_class
        slot = _result_slot(routing_class, policy)
    if (
        routing_class == "ambient"
        and policy.suggest
        and type(event.content) is dict
        and event.content.get("hit") is False
    ):
        # R128: an explicit miss neither pools nor re-arms (_apply_handoff);
        # waking the Surrogate on "nothing happened" would only offer a
        # re-armed stale alert a second chance to speak.
        return ()
    reason = WakeReason(
        kind=event.KIND,
        priority=policy.priority,
        routing_class=routing_class,
        origin=event.delegate_id,
    )
    return ((slot, reason),)


def _progress_delegate(event: ProgressEvent, ledger: DelegateLedger) -> Delegate | None:
    """Resolve only a valid observation attached to its exact active run."""
    if (
        type(event.channel) is not str
        or type(event.delegate_id) is not str
        or type(event.op) is not str
        or not event.op
        or event.phase not in {"started", "working"}
        or type(event.internal_activity) is not int
        or type(event.elapsed) not in {int, float}
        or not math.isfinite(event.elapsed)
        or event.elapsed < 0
    ):
        return None
    if event.phase == "started" and event.internal_activity != 0:
        return None
    if event.phase == "working" and not 1 <= event.internal_activity <= 1_048_576:
        return None
    # R103 second line of defense: None, or 1..400 printable chars; `started`
    # never carries one. A violation drops the whole decoration, trace-only.
    if not valid_progress_summary(event.summary, phase=event.phase):
        return None
    delegate = ledger.in_flight_delegate(event.delegate_id)
    if delegate is None:
        return None
    if delegate.executor != event.channel or delegate.op != event.op:
        return None
    return delegate


def _wake_progress(event: ProgressEvent, memory: Memory, ledger: DelegateLedger) -> WakeTargets:
    delegate = _progress_delegate(event, ledger)
    if delegate is None:
        return ()
    policy = memory.policies[event.channel]
    if policy.progress_via_surrogate:
        if event.phase != "working" or event.summary is None:
            return ()
        return (
            (
                SLOT_WATCH,
                WakeReason(
                    kind=event.KIND,
                    priority=policy.priority,
                    routing_class="ambient",
                    origin=delegate.delegate_id,
                ),
            ),
        )
    return (
        (
            _result_slot(delegate.routing_class, policy),
            WakeReason(
                kind=event.KIND,
                priority=policy.priority,
                routing_class=delegate.routing_class,
                origin=delegate.delegate_id,
            ),
        ),
    )


def observation_delegate(
    event: ObservationEvent,
    ledger: DelegateLedger,
) -> Delegate | None:
    """Resolve only an observation bound to the exact active executor run."""
    if (
        type(event.channel) is not str
        or type(event.delegate_id) is not str
        or type(event.op) is not str
        or type(event.origin_ref) is not str
        or type(event.content) is not dict
    ):
        return None
    delegate = ledger.in_flight_delegate(event.delegate_id)
    if delegate is None:
        return None
    if (
        event.channel != delegate.executor
        or event.op != delegate.op
        or event.origin_ref != delegate.origin_ref
    ):
        return None
    return delegate


def _wake_observation(
    event: ObservationEvent,
    memory: Memory,
    ledger: DelegateLedger,
) -> WakeTargets:
    delegate = observation_delegate(event, ledger)
    if delegate is None or event.content.get("hit") is not True:
        return ()
    policy = memory.policies[event.channel]
    return (
        (
            _result_slot(delegate.routing_class, policy),
            WakeReason(
                kind=event.KIND,
                priority=policy.priority,
                routing_class=delegate.routing_class,
                origin=delegate.delegate_id,
            ),
        ),
    )


def _wake_deadline(event: Deadline, memory: Memory, ledger: DelegateLedger) -> WakeTargets:
    """Only wake up if **this very hop terminated** the delegate.

    This is the confluence of step 4 of termination rule 2 and rule 3. The
    question is "did **this** deadline terminate it," not "is it still
    in-flight" and not "was it, over its whole life, terminated by a
    deadline" — why neither of those works is spelled out in
    delegates.terminated_by_deadline.

    Priority is taken from **the channel the original delegate belongs to**
    (01-spine.md line 112), not `USER_PRIORITY`. Hardcoding it to user level
    would be the spine granting the model a privilege escalation on its
    behalf: an ambient slow job, merely by having timed out, would gain the
    standing to interrupt the user — whereas Floor's invariant says speaking
    priority is decided by the event that triggered it; timing out doesn't
    make that job any more urgent than it originally was.

    **The slot isn't hardcoded either (R44).** This used to always return
    `SLOT_FAST`, but step 4 of the atomic four steps in 05-executors.md says
    "wake **by its routing class**" — hardcoding it to fast would let an
    ambient slow job's timeout wake FastBrain directly too, which contradicts
    the "timing out doesn't escalate" point just made above: priority wasn't
    escalated, but the slot was. Both places share `_result_slot`, so the
    handoff and deadline termination paths end up being the same rule when
    it comes to routing.
    """
    if not ledger.terminated_by_deadline(event):
        return ()
    delegate = ledger.find(event.delegate_id)
    assert delegate is not None  # We recognized this hop, so it must be in the terminated table
    policy = memory.policies[delegate.executor]
    slot = _result_slot(delegate.routing_class, policy)
    reason = WakeReason(
        kind=event.KIND,
        priority=policy.priority,
        routing_class=delegate.routing_class,
        origin=event.delegate_id,
    )
    return ((slot, reason),)


def _wake_compress(event: Compress, memory: Memory, ledger: DelegateLedger) -> WakeTargets:
    """Compress port. priority=0: it's a background call and never speaks."""
    return ((SLOT_COMPRESS, WakeReason(kind=event.KIND, priority=0)),)


def _wake_nobody(event: Event, memory: Memory, ledger: DelegateLedger) -> WakeTargets:
    """model_done / compress_done / speak_start / speak_end / assistant_spoken:
    the loop consumes these itself."""
    return ()


# Explicit wake table, one line per event class — the mechanical copy of the
# ten-row/eleven-kind table in 01-spine.md.
_WAKE: dict[str, Callable[[Any, Memory, DelegateLedger], WakeTargets]] = {
    UserInput.KIND: _wake_user_input,
    HandoffEvent.KIND: _wake_handoff,
    ProgressEvent.KIND: _wake_progress,
    ObservationEvent.KIND: _wake_observation,
    Deadline.KIND: _wake_deadline,
    Compress.KIND: _wake_compress,
    ModelDone.KIND: _wake_nobody,
    CompressDone.KIND: _wake_nobody,
    SpeakStart.KIND: _wake_nobody,
    SpeakEnd.KIND: _wake_nobody,
    AssistantSpoken.KIND: _wake_nobody,
}


def _check_executor_wiring(executors: Mapping[str, ExecutorAdapter], memory: Memory) -> None:
    """At assembly time, require these three names to line up: the registry
    key = `manifest.name` = `policy.channel`, and the blackboard recognizes it.

    The comment on `_handoff_event` says the KeyError from `policies[...]` has
    already been "downgraded to a startup-time configuration error." That
    sentence used to be false (codex review addendum): **nothing checked this
    at startup**, so it still blew up at runtime — and it blew up inside
    `_apply_handoff` *after* `terminate` had already run, at which point that
    job had both been removed from the in-flight table and left no observation
    on the blackboard at all, and the loop was dead too.

    A mismatch has a second, quieter consequence too: `_probes` uses
    `manifest.name` to recognize a channel name (`by_name` in
    `context_view._probes`), while the channel name comes from
    `policy.channel`. When the two differ, the whole R31 review chain never
    comes back — silently, forever, with no crash at all.

    So what's checked is these three being the same name, not merely "this key
    exists on the blackboard": the latter would block the first failure mode
    above but not the second, and the two are two faces of **the same wiring
    mistake**.

    **One-directional check**: every executor must have a channel, but not the
    reverse. The `ambient` channel in tests is exactly a channel with no
    executor (`tests/policies.py` explains why one isn't built for it);
    in the real world, "there's an observation source but no work to
    dispatch" is a legitimate shape too.

    **op is not checked here**: this checks wiring, not the capability table.
    When dispatching, if `manifest.op(name)` can't find it, it goes through
    the existing rejection path — that's the model's mistake, not an assembly
    mistake — the two kinds of errors don't share a single failure point.

    **Matching names isn't enough — the values must match too (R51).** The
    statement "the sole authority for policy is `ExecutorManifest.policy`" is
    written in `memory/policy.py` and `glossary.md`, but what the runtime
    actually reads is always `memory.policies[channel]` (`_wake_handoff` /
    `_apply_deadline` / `eta`) — the two places install **two separate copies**
    of the value under the same name, and nothing has ever required them to be
    equal (codex review addendum). Today they happen to be equal only because
    the fixtures are disciplined about it: `tests/policies.py` re-exports the
    same constants from `sims.py`. The day they diverge, no assertion turns
    red — the failure mode is three quiet kinds of wrong: if `typical_latency`
    drifts, `eta` keeps lying to FastBrain forever; if `priority` drifts,
    merged wakes pick the wrong winner; if `wake` drifts, the `ambient` cell
    ends up somewhere the executor never declared.
    So this turns that sentence from a **convention** into an **assembly-time
    fact**.

    **Refused option: have `Runtime.__init__` install `manifest.policy` into
    `memory.policies`.** That would also make "sole authority" true, but it
    would **paper over** a wiring mistake instead of surfacing it — the copy
    the caller filled in would be silently overwritten, and an assembly-time
    mistake would turn into "you thought you configured it, but it never took
    effect." The same reasoning is why the three names above are checked, not
    fixed up.
    """
    for name, adapter in executors.items():
        manifest = adapter.manifest
        installed = memory.policies.get(name)
        if manifest.name != name or manifest.policy.channel != name or installed is None:
            raise ValueError(
                f"执行器接线对不上：注册键 {name!r} / manifest.name {manifest.name!r} / "
                f"policy.channel {manifest.policy.channel!r} 必须同名，"
                f"且该名字要在 memory.policies 里（现有：{sorted(memory.policies)}）"
            )
        if installed != manifest.policy:
            raise ValueError(
                f"通道 {name!r} 的策略有两份且不相等：黑板上是 {installed}，"
                f"manifest 上是 {manifest.policy}。运行时读的是黑板那份，"
                f"而唯一权威是 manifest 那份（R51）——装配时把同一个对象传两处"
            )


def _active_executor_names_from_adapters(
    executors: Mapping[str, ExecutorAdapter],
) -> frozenset[str]:
    return frozenset(
        name
        for name, adapter in executors.items()
        if any(not op.readonly for op in adapter.manifest.ops)
    )


def _check_executor_cardinality(
    executors: Mapping[str, ExecutorAdapter],
    expected_active_executors: frozenset[str] | None,
) -> None:
    """Validate legacy exactly-one or an explicitly configured active set.

    A Runtime constructed without an executor subsystem (`executors=None`) remains
    useful for testing isolated spine components. Once assembly explicitly supplies
    the mapping, an empty mapping is a startup error just like two active executors.
    """
    active = _active_executor_names_from_adapters(executors)
    if expected_active_executors is None:
        if len(active) != 1:
            raise ValueError(f"loaded non-readonly executor 数量必须恰好为 1，实际为 {len(active)}")
    elif active != expected_active_executors:
        raise ValueError("loaded non-readonly executor 必须与显式配置完全一致")


class Runtime:
    """Event loop + job table. In Phase A it only does routing, none of the
    actual core behavior."""

    def __init__(
        self,
        *,
        clock: Clock,
        memory: Memory,
        trace: TraceWriter | None = None,
        fastbrain: FastBrain | None = None,
        surrogate: Surrogate | None = None,
        compressor: Compressor | None = None,
        executors: Mapping[str, ExecutorAdapter] | None = None,
        expected_active_executors: frozenset[str] | None = None,
        sink: SpeechSink | None = None,
        on_suggestion_selected: Callable[[Suggestion, WakeReason], None] | None = None,
        on_attention_decision: Callable[[AttentionDecision], None] | None = None,
        suggestion_cooldown: float = DEFAULT_COOLDOWN,
        fresh_window: float = FRESH_WINDOW,
    ) -> None:
        self.clock = clock
        self.memory = memory
        self.queue = EventQueue()
        # The sequence of events that actually ran. What replay(jsonl) compares
        # against (Phase A green item 1).
        self.applied: list[Event] = []
        self.floor = Floor()
        self.delegates = DelegateLedger()
        self.suggestions = SuggestionPool(default_cooldown=suggestion_cooldown)
        self._fresh_window = fresh_window
        self.fastbrain = fastbrain
        self.surrogate = surrogate
        self.compressor = compressor
        self.executors = dict(executors or {})
        _check_executor_wiring(self.executors, memory)
        if executors is not None:
            _check_executor_cardinality(self.executors, expected_active_executors)
        self.sink: SpeechSink = sink if sink is not None else RecordingSink(clock)
        self._on_suggestion_selected = on_suggestion_selected
        self._on_attention_decision = on_attention_decision
        self._slots = SlotSet(self._spawn_slot)
        self._trace = trace
        self._tasks: set[asyncio.Task[None]] = set()
        self._results: dict[str, Any] = {}
        self._job_seq = 0
        self._utterance_seq = 0
        self._delegate_seq = 0
        self._failure: BaseException | None = None
        self._work_ready = asyncio.Event()
        self._observers: list[EventObserver] = []
        self._user_input_refs: dict[int, asyncio.Future[MemoryRef]] = {}
        self._compress_backlog: deque[str] = deque()
        self._compress_scheduled: set[str] = set()
        self._compression_records: dict[str, _CompressionRecord] = {}
        self._latest_observation_suggestion: dict[str, str] = {}
        self._latest_progress_suggestion: dict[str, str] = {}

    # ---- Enqueueing and dispatch ----

    def post(self, event: Event, *, delay: float = 0.0) -> Event:
        """Enqueue an event. `delay` is virtual duration; deadlines use it to enter with a future ts."""
        queued = self.queue.push(event, at=self.clock.now() + delay)
        self._work_ready.set()
        return queued

    async def ingest_user_input(self, event: UserInput) -> MemoryRef:
        """Queue realtime user evidence and return its host-assigned ref after apply."""
        queued = self.post(event)
        future: asyncio.Future[MemoryRef] = asyncio.get_running_loop().create_future()
        self._user_input_refs[queued.seq] = future
        try:
            return await future
        finally:
            self._user_input_refs.pop(queued.seq, None)

    def observe(self, observer: EventObserver) -> Callable[[], None]:
        """Subscribe to applied events without exposing mutable runtime internals."""
        self._observers.append(observer)

        def unsubscribe() -> None:
            if observer in self._observers:
                self._observers.remove(observer)

        return unsubscribe

    def dispatch_external(
        self,
        request: DelegateRequest,
        *,
        reason: WakeReason,
    ) -> RuntimeDispatchResult:
        """Admit one already-normalized external model proposal without awaiting its worker."""
        return self._dispatch_request(
            request,
            reason=reason,
            view=self.compile_view(trigger_kind=reason.kind),
        )

    def update_external(self, spec: UpdateSpec, *, reason: WakeReason) -> bool:
        """Route an external model update through the existing sole structured-state writer."""
        accepted = self._update_error(spec) is None
        self._update_structured(spec, reason=reason)
        return accepted

    def confirm_suggestion_spoken(self, suggestion_id: str) -> None:
        self.suggestions.fire(suggestion_id, now=self.clock.now())

    def slot_inflight(self, slot: Slot) -> bool:
        """Read production scheduling state without exposing the mutable slot maps."""
        return self._slots.inflight[slot]

    def spawn(self, job: Awaitable[Any], make_event: MakeEvent, *, keep_result: bool = True) -> str:
        """Launch a model call or executor dispatch and return its job_id.

        The loop never awaits it. When the job completes, it posts its result as an
        event at that virtual instant.

        The job table is for results that **cannot travel inside an event**. Per the
        hygiene rule in 04-ports.md, model output enters neither events nor the trace;
        it crosses through this table and is consumed by `result_of`. Executor output
        is the opposite: the handoff is itself an event and `make_event` receives it
        directly. `_dispatch` therefore disables this option; otherwise the table
        would retain a copy nobody ever consumes.
        """
        self._job_seq += 1
        job_id = f"job-{self._job_seq}"
        task = asyncio.create_task(self._run_job(job_id, job, make_event, keep_result=keep_result))
        self._tasks.add(task)
        task.add_done_callback(lambda _task: self._work_ready.set())
        return job_id

    def result_of(self, job_id: str) -> Any:
        """**Consume** a job result. Model output exists only here, never in events or trace.

        Consume rather than inspect: each `CallRecord` retains an entire ContextView.
        Leaving records in the table would pin every model call's view in memory for
        the whole session. There is only one consumer (`_apply_model_done`), and a
        second read is itself a bug. An immediate KeyError is safer than returning a
        stale view that should already have been discarded.
        """
        return self._results.pop(job_id)

    async def _run_job(
        self, job_id: str, job: Awaitable[Any], make_event: MakeEvent, *, keep_result: bool
    ) -> None:
        result = await job
        if keep_result:
            self._results[job_id] = result
        # Enqueue **before** the task finishes. Otherwise, in the instant between
        # "task done" and "event enqueued", the loop can decide there is no work and
        # advance virtual time first.
        self.post(make_event(job_id, result))

    def _reap(self) -> None:
        """Reap completed tasks and retain the first exception.

        This cannot rely on add_done_callback: callbacks are scheduled with
        call_soon, and the loop may decide there is no work and exit before one
        runs. A failed executor would then **die silently**, leaving its delegate
        with neither a handoff nor any follow-up.
        """
        for task in [task for task in self._tasks if task.done()]:
            self._tasks.discard(task)
            if task.cancelled():
                continue
            failure = task.exception()
            if failure is not None and self._failure is None:
                self._failure = failure

    def runnable_task_count(self) -> int:
        """Count runnable tasks as live tasks **minus the set** asleep on the virtual clock.

        Two details are deliberately explicit:

        **Use set difference, not numeric subtraction.** If a job creates child tasks,
        such as gathering two clock sleeps, "live count - sleeping count" can report
        zero runnable tasks. Virtual time then advances early, splitting two same-tick
        events across different timestamps where kind_rank can no longer order them.

        **Count asyncio.all_tasks(), not only tasks spawned here.** Child tasks do not
        appear in self._tasks; missing them recreates the hole above. The cost is that
        any task suspended outside the clock stalls the loop instead of advancing
        time. That is the declared safe failure mode — no event loss — and bounded
        tests enforce it.
        """
        if not isinstance(self.clock, VirtualClock):
            raise RuntimeError("runnable_task_count 仅用于 VirtualClock")
        current = asyncio.current_task()
        alive = {task for task in asyncio.all_tasks() if task is not current and not task.done()}
        return len(alive - self.clock.waiting_tasks())

    # ---- Main loop ----

    async def run(self, *, max_steps: int | None = None) -> None:
        """Run until no work remains.

        max_steps is a **test-only** scheduling bound for assertions built around an
        intentionally broken simulator. Exhausting it cancels in-flight jobs as part
        of its semantics, not as a defect, which is why it must not appear on a
        production path.
        """
        if not isinstance(self.clock, VirtualClock):
            raise TypeError("run() 需要 VirtualClock；RealClock 请使用 serve(stop)")
        steps = 0
        try:
            while max_steps is None or steps < max_steps:
                steps += 1
                self._reap()
                if self._failure is not None:
                    raise self._failure

                # 1. Runnable tasks first. They may post events at **this very instant**.
                if self.runnable_task_count() > 0:
                    await asyncio.sleep(0)
                    continue

                # 2. Ready events. apply is synchronous, making the deadline's atomic
                # four steps a structural guarantee.
                event = self.queue.pop_ready(self.clock.now())
                if event is not None:
                    self._process_event(event, reclaim=False)
                    continue

                # 3. Advance virtual time only when neither of the above exists.
                next_ts = _earliest(self.queue.next_ts(), self.clock.next_timer_ts())
                if next_ts is None:
                    break
                self.clock.advance_to(next_ts)
        finally:
            shutdown_cancelled = await self._shutdown()
            if shutdown_cancelled:
                raise asyncio.CancelledError
        # Check once more after leaving the loop: a task that failed on the last tick
        # must not die silently either.
        if self._failure is not None:
            raise self._failure

    async def serve(self, stop: asyncio.Event) -> None:
        """Run against wall time until explicitly stopped.

        Temporary idleness is a wait state, not termination. Each turn yields once
        before taking a due event so an already-ready handoff can enter the queue and
        still beat a same-tick deadline through `kind_rank`.
        """
        if not isinstance(self.clock, RealClock):
            raise TypeError("serve(stop) 需要 RealClock；VirtualClock 请使用 run()")
        try:
            while not stop.is_set():
                self._reap()
                if self._failure is not None:
                    raise self._failure

                await asyncio.sleep(0)
                self._reap()
                if self._failure is not None:
                    raise self._failure

                event = self.queue.pop_ready(self.clock.now())
                if event is not None:
                    self._process_event(event, reclaim=True)
                    continue

                self._work_ready.clear()
                if stop.is_set():
                    break
                event = self.queue.pop_ready(self.clock.now())
                if event is not None:
                    self._process_event(event, reclaim=True)
                    continue

                waits = [
                    asyncio.create_task(self._work_ready.wait()),
                    asyncio.create_task(stop.wait()),
                ]
                next_ts = self.queue.next_ts()
                if next_ts is not None:
                    waits.append(
                        asyncio.create_task(self.clock.sleep(max(0.0, next_ts - self.clock.now())))
                    )
                done, pending = await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
                for task in pending:
                    task.cancel()
                await asyncio.gather(*done, *pending, return_exceptions=True)
        finally:
            shutdown_cancelled = await self._shutdown()
            self.delegates.clear_routing_indexes()
            if shutdown_cancelled:
                raise asyncio.CancelledError
        if self._failure is not None:
            raise self._failure

    def _process_event(self, event: Event, *, reclaim: bool) -> None:
        """Shared `apply → wake → observe → lifecycle` event step.

        Observers may project dispatch-bound routing metadata, which expires when
        observation completes. Routing reclamation remains the final reader of a
        routed event when this loop mode permits it.
        """
        self.apply(event)
        for slot, reason in wake_targets(event, self.memory, ledger=self.delegates):
            self.wake(slot, reason)
        for observer in tuple(self._observers):
            observer(event)
        if isinstance(event, HandoffEvent):
            self.delegates.clear_observer_handoff_claim(event)
        if reclaim:
            self.delegates.after_routing(event)

    async def _shutdown(self) -> bool:
        """Cancel jobs once and finish their cleanup despite repeated cancellation.

        Return whether a new cancellation arrived while shutdown itself was
        awaiting the workers.  Callers re-raise it only after the cleanup barrier
        and routing-index cleanup have completed.
        """
        alive = [task for task in self._tasks if not task.done()]
        for task in alive:
            task.cancel()
        interrupted = False
        if alive:
            completion = asyncio.gather(*alive, return_exceptions=True)
            while not completion.done():
                try:
                    await asyncio.shield(completion)
                except asyncio.CancelledError:
                    interrupted = True
            completion.result()
        self._reap()
        return interrupted

    # ---- apply ----

    def apply(self, event: Event) -> None:
        """Write Memory, update Floor, and append one JSONL row. One event at a time, synchronously."""
        self.applied.append(event)
        if self._trace is not None:
            self._trace.write(event)
        _APPLY[event.KIND](self, event)

    def wake(self, slot: str, reason: WakeReason) -> None:
        """Wake a slot. Only enqueue/spawn; never recurse into apply.

        **Ignore an unwired slot** rather than raising. The wake table produces
        targets row-for-row from the event table even when an optional model port is
        absent. Ignoring leaves inflight unset; setting it would permanently jam a
        slot that can never clear.
        """
        if self._port_of(slot) is None:
            return
        self._slots.wake(slot, reason)

    def _port_of(self, slot: str) -> FastBrain | Surrogate | Compressor | None:
        """Map a slot to its wired port, or None when that optional port is absent."""
        if slot == SLOT_FAST:
            return self.fastbrain
        if slot == SLOT_WATCH:
            return self.surrogate
        if slot == SLOT_COMPRESS:
            return self.compressor
        return None

    def _open_floor(self, utterance_id: str, priority: int) -> bool:
        """Request the floor, called **by the streaming task before its first sink write** (R5).

        `preempt` and `allow` share one path: both post a speak_start, and Floor's
        `on_speak_start` replaces the current utterance wholesale. The preempted
        utterance's late speak_end cannot enter (`on_speak_end` checks utterance_id),
        so no compensating event is needed. **Actually cutting off the previous
        utterance has no action in a text CLI**; it appears only when TTS is wired,
        as a sink implementation concern rather than a structural change here.

        Post rather than only mutating `self.floor` in place: every Floor transition
        must be a replayable event, or replayed Floor history diverges from the live
        run.

        **Then claim an in-place reservation after posting** (R36). Posting only puts
        the event on the queue; `self.floor` does not change until apply. With two
        concurrent slots, there is a real window where speak_start remains queued
        while text is already streaming. A `surrogate.watch` view compiled then
        would say `floor=idle`, leading Surrogate to conclude that it may speak.
        The reservation does not break replay: `_apply_speak_start` later computes
        the same transition idempotently with the same inputs. Letting Surrogate read
        a one-tick-old Floor is not conservative — it returns the opposite of reality.
        """
        if self.floor.decide(priority) == "defer":
            return False
        self.post(SpeakStart(utterance_id=utterance_id, priority=priority))
        self.floor = self.floor.on_speak_start(utterance_id, priority)
        return True

    def _close_floor(self, utterance_id: str) -> None:
        self.post(SpeakEnd(utterance_id=utterance_id))

    def compile_view(
        self,
        *,
        selected_suggestion: str | None = None,
        trigger_kind: str | None = None,
        suggestions: Sequence[Suggestion] | None = None,
    ) -> ContextView:
        """Compile a view of this instant without caching runtime-owned values that change each tick.

        Pass the **full** suggestion pool. View compilation evaluates cooldown and
        expiry lazily against `now` (03-context-view.md), so the spine needs no tick
        event to wake them. Manifests come from the executor registry; `_probes` uses
        them to compile an `unknown` into an available verification op (R31).
        """
        return compile_context_view(
            self.memory,
            floor=self.floor.state,
            now=self.clock.now(),
            in_flight=self.delegates.snapshot(),
            suggestions=self.suggestions.all() if suggestions is None else suggestions,
            manifests=tuple(adapter.manifest for adapter in self.executors.values()),
            selected_suggestion=selected_suggestion,
            trigger_kind=trigger_kind,
            fresh_window=self._fresh_window,
        )

    def _spawn_slot(self, slot: Slot, reason: WakeReason) -> None:
        """The landing point after SlotSet decides a call should run. **Compile the view here.**

        Do not compile it in wake: a pending rerun bypasses wake and returns here
        directly. Compiling one step earlier would make the rerun see the world from
        before the previous call.
        """
        if slot == SLOT_WATCH:
            self._spawn_watch(slot, reason)
            return
        if slot == SLOT_COMPRESS:
            self._spawn_compress(slot)
            return
        assert self.fastbrain is not None  # wake() has already filtered out None
        self._utterance_seq += 1
        # A selection is material carried by **this wake**, not a global runtime
        # scalar (R39). Reading it from reason means the wake that wins `higher()`
        # carries its own entry; the losing wake and its selection are discarded
        # together, leaving that suggestion pending in the pool.
        #
        # **Recheck availability now** after retrieving it. Pending merges and the
        # four on_done steps separate Surrogate's selection from this spawn, and
        # another path may have spoken and locked the entry meanwhile. Without the
        # recheck, a stale ticket can replay a locked suggestion, bypassing both locks.
        selected = self._checked_selection(reason.selected_suggestion)
        job = run_fast_brain_call(
            self.fastbrain,
            view=self.compile_view(
                selected_suggestion=selected,
                trigger_kind=reason.kind,
            ),
            reason=reason,
            utterance_id=f"u-{self._utterance_seq}",
            sink=self.sink,
            open_floor=self._open_floor,
            close_floor=self._close_floor,
            selected_suggestion=selected,
        )
        self.spawn(job, lambda job_id, _result: ModelDone(slot=slot, job_id=job_id))

    def _checked_selection(self, suggestion_id: str | None) -> str | None:
        """Return whether a selection remains valid **at the instant the call starts**.

        `_consume_watch` checks once; this is the second check. Pending merges and
        the four on_done steps lie between them, enough time for another path to
        speak and lock the same entry. Both sites use the same `is_available`
        predicate and differ only in `now`; that time difference is the entire gap.
        """
        if suggestion_id is None:
            return None
        suggestion = self.suggestions.get(suggestion_id)
        if suggestion is None or not is_available(suggestion, self.clock.now()):
            return None
        return suggestion_id

    def _spawn_watch(self, slot: Slot, reason: WakeReason) -> None:
        """The Surrogate slot. Compile its view here for the same reason as FastBrain's.

        It takes no utterance_id and touches neither sink nor Floor. Surrogate
        generates no words and therefore has no floor to claim; half of the
        single-persona invariant is enforced by what this path lacks.
        """
        assert self.surrogate is not None  # wake() has already filtered out None
        trigger: AttentionTrigger | None = None
        if reason.kind == ProgressEvent.KIND:
            delegate = self.delegates.in_flight_delegate(reason.origin)
            suggestion_id = self._latest_progress_suggestion.get(reason.origin)
            suggestion = self.suggestions.get(suggestion_id) if suggestion_id is not None else None
            if suggestion is not None and not is_available(suggestion, self.clock.now()):
                self._latest_progress_suggestion.pop(reason.origin, None)
            elif (
                delegate is not None
                and suggestion is not None
                and len(suggestion.evidence_refs) == 1
            ):
                memory_ref = suggestion.evidence_refs[0]
                channel, _ = parse_ref(memory_ref)
                if channel == delegate.executor:
                    trigger = AttentionTrigger(
                        suggestion_id=suggestion.id,
                        delegate_id=delegate.delegate_id,
                        channel=channel,
                        memory_ref=memory_ref,
                    )
        job = run_surrogate_call(
            self.surrogate,
            view=self.compile_view(
                trigger_kind=reason.kind,
                suggestions=self._attention_suggestions(trigger),
            ),
            reason=reason,
            trigger=trigger,
        )
        self.spawn(job, lambda job_id, _result: ModelDone(slot=slot, job_id=job_id))

    def _attention_suggestions(self, trigger: AttentionTrigger | None) -> tuple[Suggestion, ...]:
        """Offer progress only to the watch call carrying its exact evidence trigger."""
        progress_ids = frozenset(self._latest_progress_suggestion.values())
        triggered_id = None if trigger is None else trigger.suggestion_id
        return tuple(
            suggestion
            for suggestion in self.suggestions.all()
            if suggestion.id not in progress_ids or suggestion.id == triggered_id
        )

    def _spawn_compress(self, slot: Slot) -> None:
        """Freeze one channel's full raw log and run the single compression slot."""
        assert self.compressor is not None
        channel_name = self._compress_backlog.popleft()
        items = tuple(self.memory.channels[channel_name].items)
        job_id = self.spawn(
            _compress_guarded(self.compressor, items),
            lambda completed_job, _result: CompressDone(
                channel=channel_name,
                job_id=completed_job,
            ),
        )
        self._compression_records[job_id] = _CompressionRecord(
            channel=channel_name,
            snapshot_count=len(items),
        )

    def _continue_compression(self) -> None:
        """Drain the channel backlog whenever the single compression slot becomes idle.

        SlotSet.pending is only an edge trigger and intentionally collapses duplicate
        wakes. Channel identity and multiplicity live exclusively in the backlog.
        """
        if self._compress_backlog and not self._slots.inflight[SLOT_COMPRESS]:
            self.wake(
                SLOT_COMPRESS,
                WakeReason(kind=Compress.KIND, priority=0),
            )

    def _append_memory(
        self,
        channel: str,
        *,
        ts: float,
        trust: Trust,
        priority: int,
        content: dict[str, Any],
        outcome: Outcome | None = None,
        refs: tuple[MemoryRef, ...] = (),
    ) -> MemoryItem:
        """The runtime's only channel write path: append, then detect watermark."""
        item = self.memory.append(
            channel,
            ts=ts,
            trust=trust,
            priority=priority,
            content=content,
            outcome=outcome,
            refs=refs,
        )
        policy = self.memory.policies[channel]
        if (
            self.compressor is not None
            and self.memory.channels[channel].uncompressed >= policy.compress_watermark
            and channel not in self._compress_scheduled
        ):
            self._compress_scheduled.add(channel)
            self._compress_backlog.append(channel)
            self.post(Compress(channel=channel))
        return item

    def _apply_user_input(self, event: UserInput) -> None:
        """Apply an external observation, one of the two valid rearm triggers (R35)."""
        content: dict[str, Any] = {"text": event.text}
        if event.media_refs:
            content["media_refs"] = event.media_refs
        item = self._append_memory(
            CONVERSATION_CHANNEL,
            ts=event.ts,
            trust="trusted_user",
            priority=USER_PRIORITY,
            content=content,
        )
        future = self._user_input_refs.get(event.seq)
        if future is not None and not future.done():
            future.set_result(item.ref)
        self.suggestions.rearm_from(CONVERSATION_CHANNEL, now=event.ts)

    def _apply_handoff(self, event: HandoffEvent) -> None:
        """Append unconditionally. Wakes may be throttled; writes may not — the channel is the trace.

        **Late handoffs use this same path unchanged.** A None result from terminate
        means the delegate is no longer in flight because its deadline arrived first.
        The handoff therefore cancels no timer, creates no new deadline, and is not a
        second delegate; it is only an observation. `_wake_handoff` can still use the
        routing class bound at dispatch because `routing_class_of` also checks the
        terminated table. One delegate can thus leave at most two result observations:
        the spine's `unknown` and the late handoff.

        **A late handoff does one additional thing** (R53): record that the work later
        reached a definite result. Termination history cannot change under rule 3,
        while R49's unknown fence reads that record. Without this marker, a late `ok`
        could sit on the blackboard while the fence still blocks a resend and claims
        the work is stuck at unknown. Record it unconditionally rather than branching
        on lateness: on the normal path this handoff is itself the terminator, which
        the fence already ignores, so the marker is idempotent.
        """
        # Termination rule 1: a handoff removes the delegate from in-flight.
        # **Omitting this can still leave tests green** until ContextView is inspected:
        # the work remains in-flight, eta keeps growing, and the view keeps lying.
        handoff_delegate = self.delegates.claim_first_handoff(event)
        self.delegates.terminate(event.delegate_id, event=event)
        self._latest_observation_suggestion.pop(event.delegate_id, None)
        self._withdraw_unselected_progress(event.delegate_id)
        if event.outcome in _DEFINITE_OUTCOMES:
            self.delegates.note_resolved(event.delegate_id)
        policy = self.memory.policies[event.channel]
        refs = (event.origin_ref, *(ref for ref in event.refs if ref != event.origin_ref))
        appended = self._append_memory(
            event.channel,
            ts=event.ts,
            trust=event.trust,
            priority=policy.priority,
            content=event.content,
            outcome=event.outcome,
            refs=refs,
        )
        # R128: `hit` is the tri-state alert marker — an explicit False is a
        # non-event terminal (window elapsed / stopped). Pooling it would keep
        # a never-expiring pending suggestion in every later Surrogate view
        # and, if ever selected, speak a contextless notification.
        explicit_miss = (
            policy.suggest and type(event.content) is dict and event.content.get("hit") is False
        )
        if (
            policy.suggest
            and event.outcome == "ok"
            and not explicit_miss
            and handoff_delegate is not None
            and handoff_delegate.executor == event.channel
            and handoff_delegate.routing_class == "ambient"
        ):
            self.suggestions.add(
                origin="executor",
                kind="notify",
                content=event.content,
                evidence_refs=(appended.ref,),
                salience=float(policy.priority),
            )
        # The other valid rearm trigger: the world represented by this channel
        # genuinely changed again (R35). The spine's deadline `unknown` and refusal
        # `failed` do not count; they are bookkeeping. A late handoff still does,
        # because it is a real observation. An explicit miss does not (R128):
        # "nothing happened" must not hand a fired alert back to `pending`.
        if not explicit_miss:
            self.suggestions.rearm_from(event.channel, now=event.ts)

    def _apply_progress(self, event: ProgressEvent) -> None:
        """Write a bounded observation without claiming termination ownership."""
        delegate = _progress_delegate(event, self.delegates)
        if delegate is None:
            return
        policy = self.memory.policies[event.channel]
        content: dict[str, Any] = {
            "op": event.op,
            "phase": event.phase,
            "internal_activity": event.internal_activity,
            "elapsed": float(event.elapsed),
        }
        if event.summary is not None:
            content["summary"] = event.summary
        appended = self._append_memory(
            event.channel,
            ts=event.ts,
            trust="trusted_system",
            priority=policy.priority,
            content=content,
            refs=(delegate.origin_ref,),
        )
        self.suggestions.rearm_from(event.channel, now=event.ts)
        if not (
            policy.progress_via_surrogate and event.phase == "working" and event.summary is not None
        ):
            return
        previous = self._latest_progress_suggestion.pop(event.delegate_id, None)
        if previous is not None:
            self.suggestions.withdraw(previous)
        suggestion = self.suggestions.add(
            origin="executor",
            kind="notify",
            content={"summary": event.summary},
            evidence_refs=(appended.ref,),
            salience=float(policy.priority),
            expires_at=event.ts + DEFAULT_COOLDOWN,
        )
        self._latest_progress_suggestion[event.delegate_id] = suggestion.id

    def _withdraw_unselected_progress(self, delegate_id: str) -> None:
        suggestion_id = self._latest_progress_suggestion.pop(delegate_id, None)
        if suggestion_id is not None:
            self.suggestions.withdraw(suggestion_id)

    def _apply_observation(self, event: ObservationEvent) -> None:
        """Append a business observation without terminating its active delegate."""
        delegate = observation_delegate(event, self.delegates)
        if delegate is None:
            return
        policy = self.memory.policies[event.channel]
        refs = (event.origin_ref, *(ref for ref in event.refs if ref != event.origin_ref))
        appended = self._append_memory(
            event.channel,
            ts=event.ts,
            trust=_executor_trust(event.trust),
            priority=policy.priority,
            content=event.content,
            refs=refs,
        )
        hit = event.content.get("hit") is True
        if not (hit and policy.suggest and delegate.routing_class == "ambient"):
            return
        previous = self._latest_observation_suggestion.get(event.delegate_id)
        if previous is not None:
            self.suggestions.withdraw(previous)
        suggestion = self.suggestions.add(
            origin="executor",
            kind="notify",
            content=event.content,
            evidence_refs=(appended.ref,),
            salience=float(policy.priority),
        )
        self._latest_observation_suggestion[event.delegate_id] = suggestion.id

    def _apply_deadline(self, event: Deadline) -> None:
        """Apply termination rule 2's atomic four steps, or rule 3's no-op.

        **Rule 1 is not handled here**: an earlier handoff has already removed the
        delegate from the in-flight table, so this deadline falls under rule 3.
        That is how this loop "cancels the timer": the event still arrives, but no
        longer identifies anything it can terminate. Removing an event from the
        queue would make the trace diverge from the actual run.

        **Step 3, "cancel this dispatch attempt," is not `task.cancel()` (R25)**.
        Cancelling the task would prevent the adapter's late handoff from ever
        arriving, even though that handoff may contain good news. What the deadline
        revokes is the delegate's **authority to terminate**: the deadline has
        already recorded `unknown`, and a later handoff must not terminate anything.
        Recording the delegate in the terminated table is that step.

        Preserve the specified four-step order: append `unknown`, then `terminate`.
        The original implementation removed the delegate first on the grounds that
        the whole apply operation is synchronous and the difference is unobservable.
        That argument covers only the successful path. If appending or looking up the
        policy raises, terminating first leaves a partial commit: the delegate is
        terminated and no longer in flight, but has neither a result nor an
        `unknown` observation. A later deadline then falls under rule 3 and cannot
        repair it. Appending first costs one extra read of the in-flight table through
        `in_flight_delegate`, and closes a real partial-commit window.
        Step 4, waking the model, is in `_wake_deadline`; the loop calls it
        immediately after applying this event.
        """
        delegate = self.delegates.in_flight_delegate(event.delegate_id)
        if delegate is None:
            return  # Rule 3: the handoff won, so this deadline does nothing.
        self._latest_observation_suggestion.pop(event.delegate_id, None)
        self._withdraw_unselected_progress(event.delegate_id)
        policy = self.memory.policies[delegate.executor]
        # Include the op and request so the model can say what it is uncertain about.
        # The delegate is about to leave the in-flight table, after which the view has
        # no other copy of its arguments.
        self._append_memory(
            delegate.executor,
            ts=event.ts,
            trust="trusted_system",
            priority=policy.priority,
            content={
                "error": "deadline_exceeded",
                "op": delegate.op,
                "request": self._deadline_request(delegate),
            },
            outcome="unknown",
            refs=(delegate.origin_ref,),
        )
        terminated = self.delegates.terminate(event.delegate_id, event=event)
        assert (
            terminated is not None
        )  # No one can mutate the table between these synchronous lines.

    def _deadline_request(self, delegate: Delegate) -> dict[str, Any]:
        """Copy request evidence while honoring generic manifest redaction."""
        adapter = self.executors[delegate.executor]
        op = adapter.manifest.op(delegate.op)
        assert op is not None  # Only a successfully bound dispatch can reach a deadline.
        sensitive = frozenset(op.sensitive_params)
        return {
            key: _REDACTED_PARAM if key in sensitive else value
            for key, value in delegate.request.items()
        }

    def _apply_compress(self, event: Compress) -> None:
        """Restore backlog state when applying a replayed or externally queued Compress."""
        if self.compressor is None or event.channel in self._compress_scheduled:
            return
        self._compress_scheduled.add(event.channel)
        self._compress_backlog.append(event.channel)

    def _apply_model_done(self, event: ModelDone) -> None:
        """Consume the slot's output and run the four `on_done` steps.

        The whole block is synchronous, so the four steps are naturally atomic.
        Consumers are selected by slot because the two slots produce different types,
        `CallRecord` and `WatchRecord`; the slot carried by `ModelDone` distinguishes
        them.
        """
        record = self.result_of(event.job_id)
        if event.slot == SLOT_WATCH:
            self._slots.on_done(event.slot, lambda: self._consume_watch(record))
            return
        self._slots.on_done(event.slot, lambda: self._consume(record))

    def _consume_watch(self, record: WatchRecord) -> None:
        """Attach the Surrogate's selection to a wake and ask FastBrain to speak.

        This completes the first leg of two-hop speech. The Surrogate never speaks:
        `SurrogateOutput` has no text field (04-ports.md). This is the enforcement
        point for the single-persona invariant. FastBrain generates the words; the
        Surrogate decides only whether to speak and which suggestion to use.

        The two checks answer different questions:

        - Membership in `record.offered` proves the suggestion was actually present
          in this watch call's view. It rejects invented IDs and suggestions rearmed
          while the call was in flight (R40).
        - Current availability accounts for a suggestion being spoken and locked by
          another path after the view was compiled but before this record is consumed.

        Either check alone leaves a gap. Availability alone accepts an ID the
        Surrogate never saw; offered-set membership alone can repeat a suggestion
        spoken while the call was in flight. Treat failure of either check as no
        selection, because honoring it would let a hallucination bypass the cooldown
        lock this stage is establishing.

        Store the selected suggestion on the wake reason, not in a runtime scalar
        (R39). The wake may lose a `higher()` merge, in which case its selection must
        be discarded with it. The second-hop wake retains the first hop's priority
        and routing class (R36); it does not escalate either.
        """
        suggestion = self._valid_watch_selection(record)
        trigger = record.trigger
        if trigger is not None:
            exact_selected = suggestion is not None and suggestion.id == trigger.suggestion_id
            self._forget_progress_trigger(trigger, withdraw=not exact_selected)
            if self._on_attention_decision is not None:
                self._on_attention_decision(
                    AttentionDecision(
                        channel=trigger.channel,
                        memory_ref=trigger.memory_ref,
                        speak=record.output.speak,
                        selected=exact_selected,
                    )
                )
        if suggestion is None:
            return
        selected_reason = WakeReason(
            kind=SELECTED_WAKE_KIND,
            priority=record.reason.priority,
            routing_class=record.reason.routing_class,
            origin=record.reason.origin,
            selected_suggestion=suggestion.id,
        )
        if self._port_of(SLOT_FAST) is not None:
            self.wake(SLOT_FAST, selected_reason)
        elif self._on_suggestion_selected is not None:
            self._on_suggestion_selected(suggestion, selected_reason)

    def _forget_progress_trigger(
        self,
        trigger: AttentionTrigger,
        *,
        withdraw: bool,
    ) -> None:
        if withdraw:
            self.suggestions.withdraw(trigger.suggestion_id)
        if self._latest_progress_suggestion.get(trigger.delegate_id) == trigger.suggestion_id:
            self._latest_progress_suggestion.pop(trigger.delegate_id, None)

    def _valid_watch_selection(self, record: WatchRecord) -> Suggestion | None:
        output = record.output
        if not output.speak or output.suggestion_id is None:
            return None
        if output.suggestion_id not in record.offered:
            return None
        suggestion = self.suggestions.get(output.suggestion_id)
        if suggestion is None or not is_available(suggestion, self.clock.now()):
            return None
        return suggestion

    def _consume(self, record: CallRecord) -> None:
        """Run step 1 of `on_done`.

        The actual requirement is to run **before step 4 reruns the pending wake**.
        That rerun recompiles the view. If the delegate has not entered the in-flight
        table by then, the view omits it and FastBrain may either dispatch it again or
        fail to mention it in filler speech. This logic runs at step 1 only because
        that is the synchronous hook exposed by `SlotSet.on_done`; there is no
        insertion point between steps 2 and 3.
        """
        if record.spoken_text and record.deferred:
            # Put speech suppressed by the Floor into the pool; do not drop or queue
            # it (02-memory.md). Until B4 supplies the real ranking formula, use the
            # wake priority as salience because it is the only available urgency
            # signal. Store a suppressed question as `question`: otherwise B4 could
            # not distinguish whether to ask the user or notify them (R29).
            #
            # Do not create another record when two-hop speech is suppressed. The
            # selected suggestion is still pending because `fired` is set only when
            # speech is actually emitted. Adding it again would create two records
            # for one utterance with independent cooldowns.
            if record.selected_suggestion is None:
                self.suggestions.add(
                    origin="fast_brain",
                    kind="question" if record.speak_act == "ask" else "notify",
                    content={"text": record.spoken_text, "utterance_id": record.utterance_id},
                    salience=float(record.reason.priority),
                )
        elif record.spoken_text:
            # AI and user speech share a channel; trust identifies the speaker (R22).
            # Persist AI speech so FastBrain can see what it just said and avoid
            # repeating itself.
            self._append_memory(
                CONVERSATION_CHANNEL,
                ts=self.clock.now(),
                trust="trusted_system",
                priority=USER_PRIORITY,
                content={"text": record.spoken_text, "utterance_id": record.utterance_id},
            )
            self._lock_spoken(record)
        # The action and speech axes are fully independent here: suppressing speech
        # above does not suppress dispatch. The two gates answer different questions,
        # in order: is the output structurally valid, and does the world it answers
        # still exist? Accept one action per call (R47), then check whether newer user
        # input superseded that call's world (R48).
        if record.contract_failures:
            self._reject_contract(record)
            return
        if record.extra_actions:
            self._reject_multiple_actions(record)
            return
        if record.action.act == "none":
            return
        superseded_by = self._superseding_user_input(record)
        if superseded_by is not None:
            self._drop_stale_action(record, superseded_by)
        elif record.action.act == "delegate" and record.action.delegate is not None:
            self._dispatch(record.action.delegate, record=record)
        elif record.action.act == "update" and record.action.update is not None:
            self._update_structured(record.action.update, reason=record.reason)

    def _superseding_user_input(self, record: CallRecord) -> MemoryItem | None:
        """Return the latest user input added after this call's view was compiled.

        This asks a mechanical question, not whether the action still makes sense.
        The latter is a judgment for the decision port; asking it in the spine would
        regress v3 toward v2. The spine compares world versions only: does the world
        answered by this call still exist?

        Consider only newer conversation entries with `trust=trusted_user`:

        - Ignore handoffs. A handoff arriving while a call is in flight is normal in
          an asynchronous design. Letting it invalidate the action would break every
          dispatch, handoff, and follow-up chain.
        - Ignore the model's own speech. FastBrain output and failed observations
          written by the spine share the conversation channel; `trust` is their only
          boundary from user speech (R22).

        Only the user can supersede the user's request.

        Use `record.view` as the anchor. It already exists for the third
        `origin_ref` check in `calls.py`, so this adds no state and follows the R40
        pattern: remember what was visible, then compare at consumption time.
        `recent` is the tail of an append-only list; its greatest `seq` is the
        conversation length visible to this call.
        """
        seen = max(
            (
                item.seq
                for channel in record.view.channels
                if channel.name == CONVERSATION_CHANNEL
                for item in channel.recent
            ),
            default=0,
        )
        newer = [
            item
            for item in self.memory.channels[CONVERSATION_CHANNEL].items
            if item.seq > seen and item.trust == "trusted_user"
        ]
        return newer[-1] if newer else None

    def _drop_stale_action(self, record: CallRecord, superseded_by: MemoryItem) -> None:
        """Drop this call's entire action axis because the user replaced its world.

        R48 reproduces this sequence: FastBrain starts answering one request, the
        user cancels it, and the first call returns and dispatches its stale action
        anyway. The model's final words acknowledge the cancellation while the
        action still occurs, so speech and behavior disagree without tripping an
        assertion.

        **This method need not wake FastBrain; waking is not forbidden.** Mutation
        testing found that adding `wake(SLOT_FAST, ...)` here changes neither the
        194-test suite nor the number of model calls. The reason is structural:
        `_consume` is step 1 of `on_done`, and `inflight` is cleared only at step 3,
        so a wake here can only merge into pending. Pending must already be nonempty:
        the superseding `UserInput` arrived after view compilation and placed its own
        wake there. Both wakes therefore merge into the same rerun. Call once, and
        let that rerun decide whether to redispatch after seeing the full conversation
        and the observation below.

        **Still write an observation** because the channel is the trace (D14).
        Omitting it would leave a partially completed action with no record, and the
        next call would assume the previous action had occurred.

        **Invalidate the whole action axis, including `update`.** Allowing updates
        while blocking only delegates sounds plausible because Structured State is
        overwritten field by field and a rerun can write again. But a stale Intent
        outlives a stale delegate: the rerun may choose not to update it, leaving an
        `objective_hypothesis` derived from the old world on the blackboard for every
        later call. A rerun can restore a skipped update; it cannot retract a false
        objective that was already written.

        The speech axis is outside this invalidation. Its tokens have already reached
        the sink and cannot be recalled, and they must enter the conversation channel
        so FastBrain sees what it said and does not repeat itself (R22).
        """
        dropped: dict[str, Any] = {
            "error": "action_superseded",
            "act": record.action.act,
            "by": superseded_by.ref,
        }
        if record.action.delegate is not None:
            dropped["executor"] = record.action.delegate.executor
            dropped["op"] = record.action.delegate.op
        self._append_memory(
            CONVERSATION_CHANNEL,
            ts=self.clock.now(),
            trust="trusted_system",
            priority=record.reason.priority,
            content=dropped,
            outcome="failed",  # It never happened.
            refs=(superseded_by.ref,),
        )

    def _lock_spoken(self, record: CallRecord) -> None:
        """Lock the pool only when speech is actually emitted (R26).

        There are two entry paths:

        **Speech selected from the pool.** Call `fire`. Firing when the Surrogate
        selects it would let a later defer or `(none, none)` consume the suggestion
        and start its cooldown even though the user heard nothing.

        **A newly generated question.** Add it to the pool as `fired`. The design in
        02-memory.md routes questions through the pool, but an `ask` admitted in B2
        speaks directly without an existing pool entry. Adding it here makes the pool
        a complete ledger of questions, not only questions that could not be asked.

        This added record currently has no consumer and cannot prevent semantic
        repetition because the pool does not deduplicate by content. It prevents only
        the same pool record from being selected twice. Real deduplication would need
        embeddings or normalization, and either requires a real-model probe showing
        the repetition's actual shape. Revisit when such a probe produces a semantic
        repeat. Keep this record because it is the only enforcement point for the
        completed question.
        """
        now = self.clock.now()
        if record.selected_suggestion is not None:
            self.suggestions.fire(record.selected_suggestion, now=now)
            return
        if record.speak_act != "ask":
            return
        asked = self.suggestions.add(
            origin="fast_brain",
            kind="question",
            content={"text": record.spoken_text, "utterance_id": record.utterance_id},
            salience=float(record.reason.priority),
        )
        self.suggestions.fire(asked.id, now=now)

    def _update_structured(self, spec: UpdateSpec, *, reason: WakeReason) -> None:
        """Apply `ActAct=update`, the sole writer of Structured State.

        There is no automatic reducer. Whether a handoff should revise Intent is a
        judgment for the model. The spine performs only four mechanical operations:
        recognize fields, normalize values, overwrite them, and increment `revision`.

        **Overwrite by field; do not reset the whole structure** (R37). Fields absent
        from the delta remain unchanged. A full reset would make a call that updates
        only `uncertainty` clear `constraints`, forcing every model call to reproduce
        the entire structure. The spine increments `revision` and rejects a model-
        supplied value because `revision` is not in `known`.

        **Record bad fields as a `failed` observation; do not raise.** Allowing
        `replace` to raise `TypeError` through apply would let one model hallucination
        kill the loop. Do not wake either: the observation exists for the next call,
        but this error must not start the R30 self-wake loop. This differs from
        `_reject`, where failure to wake would leave the model waiting forever for a
        handoff. No work was dispatched here, so nothing is waiting.

        Converting list to tuple is normalization, not leniency. All multivalue fields
        in the three structures are tuples, while model-side JSON has only lists.
        Storing a list would put a mutable hole inside a frozen object and change
        snapshot representation.

        **Run every validation before `getattr`** (R41). The `Literal` on
        `spec.target` helps the type checker but enforces nothing at runtime. An
        arbitrary target would otherwise raise `AttributeError` out of apply and let
        a hallucinated field kill the loop, contradicting the error policy above.
        """
        error = self._update_error(spec)
        if error is not None:
            self._append_memory(
                CONVERSATION_CHANNEL,
                ts=self.clock.now(),
                trust="trusted_system",
                priority=reason.priority,
                content={"error": "update_rejected", "target": spec.target, **error},
                outcome="failed",
            )
            return
        current = getattr(self.memory.structured, spec.target)
        delta = {
            key: tuple(value) if isinstance(value, list) else value
            for key, value in spec.delta.items()
        }
        updated = replace(current, **delta, revision=current.revision + 1)
        self.memory.structured = replace(self.memory.structured, **{spec.target: updated})

    def _update_error(self, spec: UpdateSpec) -> dict[str, Any] | None:
        """Describe an invalid `UpdateSpec`, or return `None` when it is valid.

        The four checks are ordered because each depends on the previous one:

        1. `target` must name one of the three structures, before the first `getattr`.
        2. `delta` must be a dictionary with only string keys. Model-side JSON can
           produce a list, and mixed key types would make the next check's `sorted()`
           raise before a `failed` observation could be written.
        3. An empty `delta` is not an update. Accepting it would increment `revision`,
           whose purpose is to signal a real change, and put a false statement in the
           trace.
        4. Every field name must be known and every value must have the right shape.

        The fourth check validates shape, not allowed values. An invalid
        `unresolved_questions=7` would fail only when the next view is compiled with
        `'int' object is not iterable`, making the error appear to belong to the view
        layer. A nested list in `constraints` is quieter: it fits until it leaves a
        mutable hole in the frozen object. Value-level checks, such as the two
        `Literal` values for `Goal.status`, remain deliberately absent. A misspelled
        status cannot crash a consumer, while moving its value whitelist into the
        spine would reintroduce heuristics. Revisit when a consumer actually branches
        on a `Literal` field's value.
        """
        if spec.target not in _UPDATE_TARGETS:
            return {"reason": "unknown_target"}
        if not isinstance(spec.delta, dict) or not all(isinstance(key, str) for key in spec.delta):
            return {"reason": "malformed_delta"}
        if not spec.delta:
            return {"reason": "empty_delta"}
        current = getattr(self.memory.structured, spec.target)
        known = {field.name for field in fields(current)} - {"revision"}
        unknown = sorted(set(spec.delta) - known)
        if unknown:
            return {"reason": "unknown_fields", "unknown": unknown}
        bad = sorted(
            key
            for key, value in spec.delta.items()
            if not _shaped_like(getattr(current, key), value)
        )
        if bad:
            return {"reason": "bad_types", "fields": bad}
        return None

    def _dispatch(self, request: DelegateRequest, *, record: CallRecord) -> None:
        """Validate, bind, track in flight, schedule the deadline, then spawn.

        The five steps are intentionally ordered. Enqueue the deadline **before**
        spawning: otherwise an adapter that returns immediately could enqueue its
        handoff first and its deadline second, scheduling a timer for work that has
        already terminated.
        """
        self._dispatch_request(request, reason=record.reason, view=record.view)

    def _dispatch_request(
        self,
        request: DelegateRequest,
        *,
        reason: WakeReason,
        view: ContextView,
    ) -> RuntimeDispatchResult:
        problem = self._reject_reason(request, view=view)
        if problem is not None:
            self._reject(request, problem, reason=reason)
            return RuntimeDispatchResult(accepted=False, problem=problem)

        adapter = self.executors[request.executor]
        op = adapter.manifest.op(request.op)
        assert op is not None  # `_reject_reason` already verified it.
        self._delegate_seq += 1
        delegate = bind_delegate(
            request,
            wake_reason=reason,
            op=op,
            now=self.clock.now(),
            delegate_id=f"d-{self._delegate_seq}",
        )
        self.delegates.dispatch(delegate)
        self.post(Deadline(delegate_id=delegate.delegate_id), delay=op.deadline_budget)

        # The context's delegate must also be the executor's private copy (R54).
        # `Delegate` is frozen but `request` is a dict. `replace` alone would preserve
        # that dict, letting an adapter mutate the ledger's deduplication key in place
        # and evade both R28 and R49. Copying here preserves the isolation established
        # by `bind_delegate`.
        def progress(payload: ProgressPayload) -> None:
            try:
                if type(payload) is not ProgressPayload:
                    return
                self.post(
                    ProgressEvent(
                        channel=delegate.executor,
                        delegate_id=delegate.delegate_id,
                        op=delegate.op,
                        phase=payload.phase,
                        internal_activity=payload.internal_activity,
                        elapsed=payload.elapsed,
                        summary=payload.summary,
                    )
                )
            except Exception:
                # Progress is decorative and cannot break the terminal handoff.
                return

        def observe(payload: ObservationPayload) -> None:
            try:
                if type(payload) is not ObservationPayload:
                    return
                self.post(
                    ObservationEvent(
                        channel=delegate.executor,
                        delegate_id=delegate.delegate_id,
                        op=delegate.op,
                        origin_ref=delegate.origin_ref,
                        trust=_executor_trust(payload.trust),
                        content=dict(payload.content),
                        refs=tuple(payload.refs),
                    )
                )
            except Exception:
                # Observations cannot break the adapter's terminal handoff.
                return

        ctx = DispatchContext(
            clock=self.clock,
            delegate=replace(delegate, request=dict(delegate.request)),
            progress=progress,
            observe=observe,
        )
        # A handoff is already an event, so do not retain an unused job result.
        # Construct the event from this delegate and the adapter result inside the
        # guard: identity comes from the delegate (R46), and malformed adapter output
        # can fail during construction itself.
        self.spawn(
            _dispatch_guarded(adapter, delegate, ctx),
            lambda _job_id, event: event,
            keep_result=False,
        )
        return RuntimeDispatchResult(accepted=True, delegate_id=delegate.delegate_id)

    def _reject_reason(self, request: DelegateRequest, *, view: ContextView) -> str | None:
        """Return one of five reasons a request cannot be dispatched.

        Missing executors and operations are both rejected here. `_Sim.dispatch` can
        turn an unknown operation into a failed observation, but only after dispatch;
        a nonexistent executor provides no dispatch target at all. Since this layer
        is required for the executor check, it also handles the same class of
        hallucination for operations.

        The third rule comes from the B1 probe (R28). Even with an in-flight
        `set_light` visible and an explicit instruction not to duplicate it, qwen-max
        repeated the identical dispatch in two of three runs while its speech axis
        said the light was already being adjusted. The two axes reason independently,
        so only a structural guard is reliable.

        The fourth rule (R49) covers the same failure after `unknown`, when the
        delegate has left the in-flight table and the third rule no longer applies.
        Read-only operations are exempt because they are the verification path
        required by R13 and R31. This check therefore follows the `OpSpec` lookup and
        branches on `op.readonly`.

        Despite its query-like name, the fourth rule also records a side effect:
        `note_fenced` allows each unknown result to be fenced once. Each dispatch
        attempt calls this method exactly once, and a non-`None` result always causes
        rejection, so querying and fencing are one operation here. Splitting them
        would require returning the matching rule solely for a nonexistent second
        caller.
        """
        adapter = self.executors.get(request.executor)
        if adapter is None:
            return f"没有这个执行器：{request.executor}"
        op = adapter.manifest.op(request.op)
        if op is None:
            return f"{request.executor} 没有这个 op：{request.op}"
        duplicate = self.delegates.duplicate_of(request.executor, request.op, request.request)
        if duplicate is not None:
            return f"{duplicate.delegate_id} 正在做同一件事"
        if not op.readonly:
            unresolved = self.delegates.unresolved_duplicate_of(
                request.executor, request.op, request.request
            )
            if unresolved is not None:
                self.delegates.note_fenced(unresolved.delegate_id)  # Fence each result once.
                return f"{unresolved.delegate_id} 停在 unknown，先复核再决定要不要重发"
        return validate_origin_ref(request.origin_ref, memory=self.memory, view=view)

    def _reject(self, request: DelegateRequest, problem: str, *, reason: WakeReason) -> None:
        """Write a failed observation and wake FastBrain; do not raise.

        Store the observation in the conversation channel, not an executor channel.
        The request never reached an executor, so recording it there would falsely
        claim an interaction. A hallucinated executor may not even have a channel.

        Preserve the current routing class and priority. A bad reference generated by
        the model does not justify interrupting the user.

        **Write every observation, but compensate at most once per wake chain** (the
        revised R30). A rejected dispatch still needs a wake to preserve the rule that
        dispatched work always has a follow-up; otherwise the model waits forever for
        a handoff that will never arrive. But a wake can produce another invalid
        request, creating a reject, wake, redispatch, reject loop. Brake by wake chain:
        a wake that is itself rejection compensation receives no second compensating
        wake. This limits even an infinite sequence of distinct invalid requests to
        one extra call while new user-input, handoff, and deadline chains get a fresh
        compensation opportunity. Braking by request identity cannot do this because
        all four identity fields have unbounded value spaces; review testing reached
        50 model calls.
        """
        self.delegates.note_rejection(request)  # Keep evidence; this is no longer the brake.
        self._refuse(
            {
                "error": "delegate_rejected",
                "problem": problem,
                "executor": request.executor,
                "op": request.op,
                "origin_ref": request.origin_ref,
            },
            reason=reason,
        )

    def _reject_multiple_actions(self, record: CallRecord) -> None:
        """Reject every action when one call returns more than one (R47).

        Write a failed observation so the model can recover. The old last-write-wins
        behavior silently discarded earlier actions. If one call dispatched two
        `set_light` operations, the first could vanish without a trace, another form
        of work with no follow-up.

        Do not execute the first action and reject only the rest. That would produce
        the ambiguous failure "one of your two requests was handled; guess which."
        Executing none and notifying the model lets the next call dispatch one,
        consume its handoff, and dispatch the second through an existing, fully
        traceable path.

        This does not make the action axis plural. D5 makes the two axes orthogonal,
        but multiple actions would require redesigning the whole arbitration path:
        action order, whether another action survives one rejection, and the atomicity
        of `_dispatch`'s five steps. Revisit if Stage C real-model probes consistently
        produce two tool calls that should both execute in one turn.
        """
        self._refuse(
            {
                "error": "multiple_actions",
                "count": record.extra_actions + 1,
                "act": record.action.act,
            },
            reason=record.reason,
        )

    def _reject_contract(self, record: CallRecord) -> None:
        """Record malformed model structure and use the existing one-hop compensation brake."""
        first = record.contract_failures[0]
        content: dict[str, Any] = {
            "error": "model_contract_failure",
            "code": first.code,
            "tool_name": first.tool_name,
        }
        if len(record.contract_failures) > 1:
            content["count"] = len(record.contract_failures)
        self._refuse(content, reason=record.reason)

    def _refuse(self, content: dict[str, Any], *, reason: WakeReason) -> None:
        """Share rejection handling: a failed observation and a braked wake.

        Both rejection paths must use the same brake (the revised R30). A model that
        returns two actions every turn otherwise forms the same self-wake loop seen in
        the 50-call R30 probe: reject, wake, return two actions, reject again.

        Always write the observation because the channel is the trace (D14), but
        compensate only non-compensation chains. Preserve routing class and priority;
        the model's own error does not justify interrupting the user.
        """
        self._append_memory(
            CONVERSATION_CHANNEL,
            ts=self.clock.now(),
            trust="trusted_system",
            priority=reason.priority,
            content=content,
            outcome="failed",
        )
        if reason.kind == REJECTED_WAKE_KIND:
            return  # This call was already compensation; stop the chain here.
        self.wake(
            SLOT_FAST,
            WakeReason(
                kind=REJECTED_WAKE_KIND,
                priority=reason.priority,
                routing_class=reason.routing_class,
            ),
        )

    def _apply_compress_done(self, event: CompressDone) -> None:
        """Atomically publish a non-empty summary and preserve concurrent appends."""
        if self.compressor is None:
            return
        result = self.result_of(event.job_id)
        record = self._compression_records.pop(event.job_id)
        assert record.channel == event.channel

        def consume() -> None:
            channel = self.memory.channels[record.channel]
            self._compress_scheduled.discard(record.channel)
            if isinstance(result, _CompressionResult) and result.summary is not None:
                channel.summary = result.summary
                channel.uncompressed = max(0, channel.uncompressed - record.snapshot_count)
                policy = self.memory.policies[record.channel]
                if channel.uncompressed >= policy.compress_watermark:
                    self._compress_scheduled.add(record.channel)
                    self._compress_backlog.append(record.channel)

        self._slots.on_done(SLOT_COMPRESS, consume)
        self._continue_compression()

    def _apply_speak_start(self, event: SpeakStart) -> None:
        self.floor = self.floor.on_speak_start(event.utterance_id, event.priority)

    def _apply_speak_end(self, event: SpeakEnd) -> None:
        """Release the floor only for the current utterance.

        The Floor itself ignores a late end event from an interrupted utterance.
        """
        self.floor = self.floor.on_speak_end(event.utterance_id)

    def _apply_assistant_spoken(self, event: AssistantSpoken) -> None:
        # AI and user speech share a channel; trust identifies the speaker (R22).
        # Renderer delivery evidence owns whether anything was audible. A spoken
        # event carries completed output; an interrupted event may carry a later
        # provider-final transcript, so delivery and played_ms bound user exposure.
        self._append_memory(
            CONVERSATION_CHANNEL,
            ts=event.ts,
            trust="trusted_system",
            priority=USER_PRIORITY,
            content={
                "text": event.text,
                "utterance_id": event.utterance_id,
                "delivery": event.delivery,
                "played_ms": event.played_ms,
            },
        )


# Explicit dispatch table with one row per event type. A missing type raises KeyError
# during apply instead of silently dropping the event.
_APPLY: dict[str, Callable[[Runtime, Any], None]] = {
    UserInput.KIND: Runtime._apply_user_input,
    HandoffEvent.KIND: Runtime._apply_handoff,
    ProgressEvent.KIND: Runtime._apply_progress,
    ObservationEvent.KIND: Runtime._apply_observation,
    Deadline.KIND: Runtime._apply_deadline,
    Compress.KIND: Runtime._apply_compress,
    ModelDone.KIND: Runtime._apply_model_done,
    CompressDone.KIND: Runtime._apply_compress_done,
    SpeakStart.KIND: Runtime._apply_speak_start,
    SpeakEnd.KIND: Runtime._apply_speak_end,
    AssistantSpoken.KIND: Runtime._apply_assistant_spoken,
}


# The two trust values an executor may claim. The third, `trusted_user`, is
# impersonation rather than source attribution.
_EXECUTOR_TRUST = frozenset({"trusted_system", "untrusted_external"})

# The two outcomes that definitively say whether the operation occurred. Use a
# positive allowlist rather than `!= "unknown"`: an arbitrary adapter value is still
# unknown to us and therefore not definitive (R53).
_DEFINITE_OUTCOMES = frozenset({"ok", "failed"})


def _executor_trust(declared: Trust) -> Trust:
    """Allow external sourcing but prevent an executor from impersonating the user.

    `trust` has no gate (02-memory.md), so this is not a security boundary. It keeps
    source attribution on the blackboard accurate: if an executor-fed observation
    were labeled `trusted_user`, FastBrain would read executor-authored text as a new
    user utterance (R46).

    Use an allowlist rather than a denylist because `Trust`'s `Literal` has no runtime
    enforcement (the R41 lesson); an adapter can still return an arbitrary value.
    Normalize anything unrecognized to `trusted_system`, which accurately identifies
    the observation as coming from an executor we dispatched.
    """
    return declared if declared in _EXECUTOR_TRUST else "trusted_system"


async def _dispatch_guarded(
    adapter: ExecutorAdapter, delegate: Delegate, ctx: DispatchContext
) -> HandoffEvent:
    """Dispatch once and prevent adapter failures from escaping (R46).

    The contract says `dispatch` never raises, but the spine cannot rely on perfect
    adapters. An adapter `AttributeError` reaching `_reap` would bring down the loop
    and strand unrelated in-flight work. The contract tells executor authors what to
    implement; this boundary defines what happens when they do not.

    Normalize failure to `unknown`, not `failed`, because an adapter exception is not
    evidence that the physical operation did not occur. Preserve the exception type
    and message in content; they are the only diagnostic evidence for the defect.

    `except Exception` deliberately excludes `CancelledError`, a `BaseException`.
    Cancelling in-flight jobs during shutdown must not leave a false `unknown`
    observation on the blackboard.

    Guard the entire conversion from adapter return value to event, not only the
    `await`. Earlier code placed `_handoff_event` outside the guard, allowing malformed
    non-raising results to crash the loop: `None` raises while reading `.outcome`, and
    an unhashable trust value raises during allowlist membership. Both are adapter
    contract violations. A `Literal` provides no runtime enforcement (R41), so valid
    values cannot be assumed.

    This does not risk swallowing spine defects. `_handoff_event` reads only values
    supplied by the adapter and four identity fields bound by the spine. Those
    identity fields cannot fail here, so any exception inside this block is
    attributable to adapter output, exactly what this boundary is meant to contain.

    This intentionally does not validate every adapter field, an option rejected by
    R46. It adds no second field schema; it moves the existing normalization boundary
    to the correct place.
    """
    try:
        # Give the executor its own copy so in-place mutation cannot alter the
        # ledger's deduplication key.
        handoff = await adapter.dispatch(delegate.op, dict(delegate.request), ctx)
        return _handoff_event(handoff, delegate)
    except Exception as failure:
        # Every field in this spine-created value is valid, so `_handoff_event` cannot
        # fail on it. Reuse the same constructor rather than duplicating identity.
        return _handoff_event(
            Handoff(
                outcome="unknown",
                trust="trusted_system",
                content={
                    "error": "adapter_raised",
                    "exception": type(failure).__name__,
                    "detail": str(failure),
                },
            ),
            delegate,
        )


def _handoff_event(handoff: Handoff, delegate: Delegate) -> HandoffEvent:
    """Convert an adapter result into an event with spine-bound identity (R46).

    The queue binds `ts` and `seq`, which adapters never control. Bind `delegate_id`,
    `channel`, and `origin_ref` from the dispatch record as well: they answer whose
    result this is, which the spine already knew when it dispatched the work. The
    adapter supplies only the result.

    Take `channel` from `delegate.executor`, the same source used by the deadline path
    in `_apply_deadline`. This reduces a `policies[...]` `KeyError` from something an
    adapter can trigger at runtime to a startup configuration error checked by
    `_check_executor_wiring` in `Runtime.__init__`. Without that startup check, a
    wiring error would still fail at runtime after `terminate`.

    **Copy `content` into a dict here to complete the guard** (R55). Malformed content
    is another way adapter output could poison the loop. If a string reached the
    blackboard unchanged, it would fail during the next view compilation in
    `context_view._updates`, after termination. Worse, the poison entry would remain
    in the channel and break every subsequent view compilation. Calling `dict()` here
    makes that `ValueError` occur inside the guard, where the existing normalization
    path turns it into `unknown`, just like an adapter exception.

    This is not the per-field validation rejected by R46. That option judged whether
    adapter values were correct. This check asks only whether content can be recorded
    as the `dict` required by `MemoryItem.content`. Since the channel is the trace
    (D14), an unrecordable value cannot become an observation. Values of `outcome` and
    `refs` remain unchanged, as noted below. The shallow copy also prevents later
    adapter mutation from changing the blackboard, for the same reason
    `bind_delegate` copies `request`.
    """
    return HandoffEvent(
        channel=delegate.executor,
        delegate_id=delegate.delegate_id,
        origin_ref=delegate.origin_ref,
        outcome=handoff.outcome,
        trust=_executor_trust(handoff.trust),
        content=dict(handoff.content),
        # Preserve `outcome` and `refs` as adapter-authored claims. A bad output is an
        # observation (R46): an unrecognized outcome or dangling ref is merely a claim
        # no consumer recognizes. Both remain recordable and cannot crash the loop.
        # Adapters own refs because a search executor returns evidence refs here. This
        # guard asks whether a result can be recorded, not whether its claim is true.
        refs=handoff.refs,
    )


def _earliest(*candidates: float | None) -> float | None:
    known = [ts for ts in candidates if ts is not None]
    return min(known) if known else None
