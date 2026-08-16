"""Wake table: table lookup, no business judgment (Phase A green item A2-4).

01-spine.md: "There is no business judgment inside apply or WAKE_TABLE. All
judgment about 'what to do' lives in the two decision ports, FastBrain and
Surrogate, plus a small handful of explicit policies (HandoffPolicy, Floor
priority, watermark thresholds)."

The one observable consequence of this today is that **wake targets and
priority are unaffected by event content** -- the text an executor returns
sits resident in memory and gets injected repeatedly, so it has even less
business steering the trunk. First check the event table line by line
(positive twin), then layer on the contamination case.
"""

from __future__ import annotations

from nova_audio_agent.delegates import DelegateLedger
from nova_audio_agent.events import (
    Compress,
    CompressDone,
    Deadline,
    HandoffEvent,
    ModelDone,
    RoutingClass,
    SpeakEnd,
    SpeakStart,
    UserInput,
    WakeReason,
)
from nova_audio_agent.executors.sims import SET_LIGHT
from nova_audio_agent.memory import CONVERSATION_CHANNEL, USER_PRIORITY, HandoffPolicy, Memory
from nova_audio_agent.ports import DelegateRequest, bind_delegate
from nova_audio_agent.runtime import wake_targets
from policies import SLOW_SIM_POLICY

WAKE_FAST = SLOW_SIM_POLICY  # the wake=fast one
WAKE_SURROGATE = HandoffPolicy(
    channel="ambient_sim",
    priority=10,
    wake="surrogate",
    typical_latency=1.0,
    compress_watermark=20,
)
WAKE_NONE = HandoffPolicy(
    channel="quiet_sim",
    priority=1,
    wake="none",
    typical_latency=1.0,
    compress_watermark=20,
)


def _memory() -> Memory:
    return Memory(policies=(WAKE_FAST, WAKE_SURROGATE, WAKE_NONE))


def _ledger_with(routing_class: RoutingClass, executor: str = "slow_sim") -> DelegateLedger:
    """A ledger holding one entry for d-1. The routing class is decided by the wake
    that happened **at dispatch time**; here it's given directly.

    `executor` can be swapped out in order to route the activity onto a channel
    with a different `wake` value -- the boundary between R44's two cells only
    shows up in the "channel says stay quiet, but the user is waiting" cell.
    """
    ledger = DelegateLedger()
    ledger.dispatch(
        bind_delegate(
            DelegateRequest(
                executor=executor,
                op="set_light",
                request={"room": "客厅", "brightness": 30},
                origin_ref="conversation:1",
            ),
            wake_reason=WakeReason(kind="user_input", priority=100, routing_class=routing_class),
            op=SET_LIGHT,
            now=0.0,
            delegate_id="d-1",
        )
    )
    return ledger


def _handoff(channel: str, **content: object) -> HandoffEvent:
    return HandoffEvent(
        channel=channel,
        delegate_id="d-1",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content=dict(content),
    )


def test_user_input_wakes_fast_brain_directly() -> None:
    """Event table, first row: wakes FastBrain directly, bypassing Surrogate."""
    targets = wake_targets(UserInput(text="把客厅灯调暗点"), _memory())

    assert [slot for slot, _ in targets] == ["fast"]
    reason = targets[0][1]
    assert reason.kind == "user_input"
    assert reason.routing_class == "user_awaited"  # the root of the chain is user input (R12)


def test_handoff_wake_follows_the_channel_policy() -> None:
    """Event table, second row: **exogenous observations** split into fast / surrogate / none by HandoffPolicy.wake.

    These three handoffs' `delegate_id` cannot be found in an empty ledger, so they
    land in the "observation nobody summoned" cell -- when there's no causal chain
    to inherit, `policy.wake` is the only source of information (R44). Results from
    activity we dispatched ourselves don't go through here; see the three cases at
    the end of this file.
    """
    memory = _memory()

    assert [slot for slot, _ in wake_targets(_handoff("slow_sim"), memory)] == ["fast"]
    assert [slot for slot, _ in wake_targets(_handoff("ambient_sim"), memory)] == [
        "surrogate.watch"
    ]
    assert wake_targets(_handoff("quiet_sim"), memory) == ()


def test_handoff_priority_comes_from_the_policy() -> None:
    targets = wake_targets(_handoff("slow_sim"), _memory())

    assert targets[0][1].priority == WAKE_FAST.priority


def test_compress_wakes_its_own_slot() -> None:
    """compress has its own slot; it doesn't merge into surrogate.watch (R1)."""
    targets = wake_targets(Compress(channel="slow_sim"), _memory())

    assert [slot for slot, _ in targets] == ["compress"]


def test_loop_internal_events_wake_nobody() -> None:
    """Event table, last four rows: model_done / compress_done / speak_start / speak_end are consumed by the loop itself."""
    memory = _memory()

    assert wake_targets(ModelDone(slot="fast", job_id="job-1"), memory) == ()
    assert wake_targets(CompressDone(channel="slow_sim", job_id="job-2"), memory) == ()
    assert wake_targets(SpeakStart(utterance_id="u-1", priority=100), memory) == ()
    assert wake_targets(SpeakEnd(utterance_id="u-1"), memory) == ()


def test_a_deadline_nobody_owns_wakes_nobody() -> None:
    """Termination rule 3: a deadline landing on an unfamiliar delegate is a no-op.

    With an empty ledger this is also the "the trunk hasn't dispatched anything yet"
    state, and the two ought to give the same answer anyway.
    """
    assert wake_targets(Deadline(delegate_id="d-1"), _memory()) == ()


def test_a_deadline_wakes_only_the_delegate_it_terminated_itself() -> None:
    """Termination rule 2, step 4: only the one that **terminated on this very hop** wakes anything.

    You can't ask "is it still in flight" -- the loop applies first and computes the
    wake target second, and by then the atomic four steps have already moved it out;
    rules 2 and 3 look identical at that moment.
    """
    memory = _memory()
    fired = Deadline(delegate_id="d-1", ts=10.0, seq=7)
    by_deadline = _ledger_with("user_awaited")
    by_deadline.terminate("d-1", event=fired)
    by_handoff = _ledger_with("user_awaited")
    by_handoff.terminate("d-1", event=_handoff("slow_sim"))

    woken = wake_targets(fired, memory, ledger=by_deadline)
    assert [slot for slot, _ in woken] == ["fast"]
    assert woken[0][1].routing_class == "user_awaited"
    assert woken[0][1].origin == "d-1"

    # handoff won that one: the deadline arriving must not call again, or else every
    # activity that finished on time would get a fake "I'm not sure" afterward.
    assert wake_targets(fired, memory, ledger=by_handoff) == ()


def test_a_second_deadline_on_the_same_delegate_wakes_nobody() -> None:
    """The other half of termination rule 3: a **second** deadline on the same delegate is also a no-op.

    Asking "was this delegate ever terminated by a deadline in its lifetime" misses
    this cell -- that question is still true here, so the same timeout would wake
    twice, and the model would say "I'm not sure whether the living room light got
    dimmed" twice. The question to ask is "did **this specific event** terminate it",
    so the ledger records the event itself.

    **The two deadlines' fields are completely identical**, just different objects.
    This is the shape codex review's third round changed: the second one used to
    carry `seq=9`, so value comparison also passed, and this case couldn't
    distinguish `record.event == event` from `record.event is event`. Value
    comparison really does misidentify here -- `Deadline`'s `ts` / `seq` have
    defaults, so two un-stamped ones are equal by value on the spot. The main loop
    passes the same object to apply and then to wake, so `is` holds both in real
    runs and on replay.

    Today the trunk only ever posts one deadline per delegate (`_dispatch` is the
    sole producer), so this cell can't be reached yet. **It's kept because that
    invariant lives in a different function, and nobody has pinned it down**:
    whichever day a second post site shows up, this is what turns red first --
    not the user's ear hearing that repeated apology.
    """
    memory = _memory()
    ledger = _ledger_with("user_awaited")
    ledger.terminate("d-1", event=Deadline(delegate_id="d-1", ts=10.0, seq=7))

    assert wake_targets(Deadline(delegate_id="d-1", ts=10.0, seq=7), memory, ledger=ledger) == ()


def test_a_deadline_wakes_at_the_delegates_own_channel_priority() -> None:
    """01-spine.md line 112: a deadline inherits the priority of **the channel the original delegate is on**.

    Hard-coding it to `USER_PRIORITY` would be the trunk granting the model a
    privilege escalation: an ambient slow activity timing out would gain the
    standing to interrupt the user on the sole basis of "it timed out". Timing out
    doesn't change how urgent the activity was to begin with.
    """
    memory = _memory()
    ledger = _ledger_with("ambient")
    fired = Deadline(delegate_id="d-1", ts=10.0, seq=7)
    ledger.terminate("d-1", event=fired)

    woken = wake_targets(fired, memory, ledger=ledger)

    assert woken[0][1].priority == SLOW_SIM_POLICY.priority == 50
    assert (
        woken[0][1].priority != USER_PRIORITY
    )  # 100, which is what the hard-coded value used to be


def test_handoff_routing_class_comes_from_the_ledger_not_the_channel_policy() -> None:
    """Where R12 lands, also the test shape for the counterexample at 05-executors.md line 105.

    Same channel, same handoff: the routing class only changes with the value bound
    **at the moment that delegate was dispatched**. If it were derived from
    HandoffPolicy instead, the user would ask something -> a search gets dispatched
    -> the search's handoff dispatches again -> the second hop becomes ambient, and
    the user's question never gets a follow-up again.
    """
    memory = _memory()

    awaited = wake_targets(_handoff("slow_sim"), memory, ledger=_ledger_with("user_awaited"))
    ambient = wake_targets(_handoff("slow_sim"), memory, ledger=_ledger_with("ambient"))

    assert awaited[0][1].routing_class == "user_awaited"
    assert ambient[0][1].routing_class == "ambient"
    # Positive twin: only the routing class changes; slot and priority still come from the channel policy.
    assert [slot for slot, _ in awaited] == [slot for slot, _ in ambient] == ["fast"]
    assert awaited[0][1].priority == ambient[0][1].priority == WAKE_FAST.priority


def test_a_handoff_nobody_claims_is_ambient() -> None:
    """A handoff nobody in the ledger claims shouldn't have the standing to interrupt the user."""
    targets = wake_targets(_handoff("slow_sim"), _memory())

    assert targets[0][1].routing_class == "ambient"


def test_wake_targets_ignores_the_event_content() -> None:
    """Contamination case: content returned by the executor must not steer the trunk."""
    memory = _memory()
    clean = wake_targets(_handoff("slow_sim"), memory)

    poisoned = wake_targets(
        _handoff("slow_sim", wake="surrogate", priority=999, routing_class="user_awaited"),
        memory,
    )

    assert poisoned == clean
    assert [slot for slot, _ in poisoned] == ["fast"]
    assert poisoned[0][1].priority == WAKE_FAST.priority


def test_conversation_channel_never_produces_a_handoff_wake() -> None:
    """The conversation channel's built-in policy is wake=none: it has no handoff, but it does have a watermark."""
    memory = _memory()

    assert wake_targets(_handoff(CONVERSATION_CHANNEL), memory) == ()
    assert memory.policies[CONVERSATION_CHANNEL].compress_watermark > 0


# ---- Result routing: channel policy must not let an answer the user is waiting for go unspoken (R44) ----


def test_a_quiet_channel_cannot_silence_a_result_the_user_is_waiting_for() -> None:
    """Gate 5. An activity the user is waiting for is dispatched on a `wake="none"` channel; when the result comes back it must still wake FastBrain.

    Before the fix this cell returned `()`: a static channel config would swallow
    the whole causal chain of "the user asked something", and "dispatching an
    activity guarantees a follow-up" is exactly what it's supposed to preserve.
    `policy.wake` answers "who usually cares about activity on this channel"; it
    has no standing to answer "is the user waiting on this one right now".

    The reverse twin is in the next case: same channel, same handoff, but when
    nobody is waiting it still follows channel policy.
    """
    memory = _memory()
    ledger = _ledger_with("user_awaited", executor="quiet_sim")

    targets = wake_targets(_handoff("quiet_sim"), memory, ledger=ledger)

    assert [slot for slot, _ in targets] == ["fast"]
    assert targets[0][1].routing_class == "user_awaited"


def test_a_quiet_channel_still_governs_a_result_nobody_awaits() -> None:
    """Reverse twin of the previous case: this only blocks the downgrade direction, not the upgrade direction.

    The `ambient` cell still follows channel policy -- at that point nobody really
    was waiting, and "is it worth mentioning" should be Surrogate's call. The two
    together show this rule is **asymmetric**, not "results always wake FastBrain"
    (which would give every ambient event the standing to interrupt the user).
    """
    memory = _memory()
    ledger = _ledger_with("ambient", executor="quiet_sim")

    targets = wake_targets(_handoff("quiet_sim"), memory, ledger=ledger)

    # wake="none" falls back to the suggestion pool for results: activity we dispatched
    # ourselves must not end up with nowhere to go.
    assert [slot for slot, _ in targets] == ["surrogate.watch"]
    assert targets[0][1].routing_class == "ambient"


def test_a_deadline_routes_by_the_same_rule_as_a_handoff() -> None:
    """Termination rule 2, step 4: "wake by **its routing class**", the slot isn't hard-coded (05-executors.md).

    Before the fix `_wake_deadline` always returned `fast`. That contradicts its own
    reasoning from the previous case: an ambient slow activity times out, priority
    doesn't get raised (that cell is already pinned by a test case), but the slot
    does get raised -- gaining the standing to wake FastBrain directly on the sole
    basis of "it timed out". The two termination paths must be the same routing
    rule, otherwise the same activity would end up in two different places
    depending on whether it went through handoff or deadline.
    """
    memory = _memory()
    fired = Deadline(delegate_id="d-1", ts=10.0, seq=7)
    ambient = _ledger_with("ambient", executor="ambient_sim")
    ambient.terminate("d-1", event=fired)
    awaited = _ledger_with("user_awaited", executor="ambient_sim")
    awaited.terminate("d-1", event=fired)

    by_deadline = wake_targets(fired, memory, ledger=ambient)
    assert [slot for slot, _ in by_deadline] == ["surrogate.watch"]

    # Same channel, only the routing class changes: the one the user was waiting on
    # timed out, so it must wake FastBrain to say "I'm not sure".
    assert [slot for slot, _ in wake_targets(fired, memory, ledger=awaited)] == ["fast"]

    # Positive twin: deadline and handoff give the same slot on the same delegate.
    assert [slot for slot, _ in wake_targets(_handoff("ambient_sim"), memory, ledger=ambient)] == [
        slot for slot, _ in by_deadline
    ]
