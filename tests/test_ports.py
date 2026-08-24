"""Observable points of the port contract (A3 implementation-phase self-testing, **doesn't count toward any phase's green-conversion items**).

Two things:
1. All nine combinations of the two axes are legal — no illegal-combination validation table is needed (D5)
2. R17: "the model can't touch deadline / routing_class" is enforced through the type, not through discipline
"""

from __future__ import annotations

import asyncio
import itertools
from collections.abc import AsyncIterator
from dataclasses import replace
from typing import Any

import pytest

from nova_audio_agent.calls import CallRecord
from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.context_view import ContextView, compile_context_view
from nova_audio_agent.events import ModelDone, UserInput, WakeReason
from nova_audio_agent.executors.search import SEARCH, SEARCH_POLICY, SearchAdapter
from nova_audio_agent.executors.sims import SET_LIGHT, SLOW_SIM_POLICY, FastSim, SlowSim
from nova_audio_agent.memory import CONVERSATION_CHANNEL, Memory, MemoryItem
from nova_audio_agent.runtime import Runtime, _dispatch_guarded, _handoff_event
from nova_audio_agent.suggestions import SELECTED_WAKE_KIND
from nova_audio_agent.ports import (
    ActionDelta,
    ActionOutput,
    DelegateRequest,
    DispatchContext,
    ExecutorManifest,
    FastBrainDelta,
    FastBrainOutput,
    Handoff,
    OpSpec,
    ProgressPayload,
    SpeakOutput,
    TextDelta,
    bind_delegate,
)
from fakes import ScriptedFastBrain, finished_call
from policies import AMBIENT_POLICY, FAST_SIM_POLICY, SIM_POLICIES

DIM_LIGHT = DelegateRequest(
    executor="slow_sim",
    op="set_light",
    request={"room": "客厅", "brightness": 30},
    origin_ref="conversation:1",
)
USER_WAKE = WakeReason(kind="user_input", priority=100, routing_class="user_awaited")


class _BoomSim:
    """An executor that **violates contract one**: dispatch raises an exception directly.

    Simulators all play by the rules, so "what happens when an adapter gets it wrong" needs a separate, rule-breaking one to ask.
    """

    def __init__(self) -> None:
        self.manifest = ExecutorManifest(name="slow_sim", ops=(SET_LIGHT,), policy=SLOW_SIM_POLICY)

    async def dispatch(self, op: str, request: dict[str, Any], ctx: DispatchContext) -> Handoff:
        raise RuntimeError("adapter 内部炸了")


class _WrongSim:
    """An executor whose **return value is invalid**: it doesn't raise, it just hands back something that isn't a usable Handoff.

    `_BoomSim` asks "what happens when it raises". This one asks "**it can blow up without raising, too**" —
    the guard only covers that one await, and these two slip right past it (added by codex review).
    """

    def __init__(self, handoff: Any) -> None:
        self.manifest = ExecutorManifest(name="slow_sim", ops=(SET_LIGHT,), policy=SLOW_SIM_POLICY)
        self._handoff = handoff

    async def dispatch(self, op: str, request: dict[str, Any], ctx: DispatchContext) -> Handoff:
        return self._handoff  # type: ignore[no-any-return]


class _MeddlingSim:
    """An executor that **mutates `ctx.delegate.request` in place**: it doesn't raise, doesn't return a bad value, it just tampers with someone else's record.

    The two above ask "what happens when the adapter is broken". This one works completely
    normally — the line it runs looks innocent in a real executor ("normalize the brightness
    before sending it to the device"), and what it mutates is the ledger's dedup key.
    """

    def __init__(self) -> None:
        self.manifest = ExecutorManifest(name="slow_sim", ops=(SET_LIGHT,), policy=SLOW_SIM_POLICY)
        self.seen: dict[str, Any] = {}

    async def dispatch(self, op: str, request: dict[str, Any], ctx: DispatchContext) -> Handoff:
        ctx.delegate.request["brightness"] = 999
        self.seen = dict(ctx.delegate.request)
        # Stops at unknown, because that's the field that most matters for "the same thing must not be resent as-is" (R49).
        return Handoff(outcome="unknown", trust="trusted_system", content={"error": "说不清"})


def test_all_nine_two_axis_combinations_are_legal() -> None:
    """All nine combinations are legal, so no illegal-combination validation table is needed (D5)."""
    combinations = [
        FastBrainOutput(
            speak=SpeakOutput(act=speak, text="好的" if speak != "none" else None),
            action=ActionOutput(act=action, delegate=DIM_LIGHT if action == "delegate" else None),
        )
        for speak, action in itertools.product(
            ("none", "say", "ask"), ("none", "delegate", "update")
        )
    ]

    assert len(combinations) == 9
    assert combinations[0] == FastBrainOutput(
        speak=SpeakOutput(act="none"), action=ActionOutput(act="none")
    )  # (none, none) is exactly the manuscript's "silent"


def test_delegate_request_cannot_express_the_runtime_bound_fields() -> None:
    """Observable point for R17: the type the model fills in simply doesn't have these two fields."""
    assert not hasattr(DIM_LIGHT, "deadline")
    assert not hasattr(DIM_LIGHT, "routing_class")
    assert not hasattr(DIM_LIGHT, "delegate_id")


def test_dispatch_context_progress_is_an_optional_decoration_port() -> None:
    delegate = bind_delegate(
        DIM_LIGHT, wake_reason=USER_WAKE, op=SET_LIGHT, now=0.0, delegate_id="d-1"
    )
    plain = DispatchContext(clock=VirtualClock(), delegate=delegate)
    seen: list[ProgressPayload] = []
    decorated = replace(plain, progress=seen.append)
    payload = ProgressPayload(phase="working", internal_activity=1, elapsed=0.5)

    assert plain.progress is None
    assert decorated.progress is not None
    decorated.progress(payload)
    assert seen == [payload]


def test_bind_delegate_takes_the_deadline_from_the_op_budget() -> None:
    """deadline is computed from OpSpec.deadline_budget, independent of model input (R9)."""
    poisoned = DelegateRequest(
        executor="slow_sim",
        op="set_light",
        # The model stuffs a deadline into request, trying to extend itself an extra hour.
        request={"room": "客厅", "brightness": 30, "deadline": 3600.0},
        origin_ref="conversation:1",
    )

    delegate = bind_delegate(
        poisoned, wake_reason=USER_WAKE, op=SET_LIGHT, now=7.0, delegate_id="d-1"
    )

    assert delegate.deadline == 7.0 + SET_LIGHT.deadline_budget
    assert delegate.dispatched_at == 7.0


def test_op_spec_accepts_only_declared_unique_exact_sensitive_parameter_names() -> None:
    sensitive = OpSpec(
        name="write",
        description="write a private request",
        params={
            "type": "object",
            "properties": {"secret": {"type": "string"}},
            "required": ["secret"],
        },
        sensitive_params=("secret",),
    )

    assert sensitive.sensitive_params == ("secret",)

    class _StringSubclass(str):
        pass

    for invalid in (
        ("missing",),
        ("secret", "secret"),
        (_StringSubclass("secret"),),
    ):
        with pytest.raises(ValueError, match="sensitive_params"):
            OpSpec(
                name="write",
                description="invalid private request",
                params={
                    "type": "object",
                    "properties": {"secret": {"type": "string"}},
                },
                sensitive_params=invalid,  # type: ignore[arg-type]
            )


def test_op_spec_sync_result_is_explicit_for_readonly_and_write_operations() -> None:
    """R105: sync_result is explicit and does not misclassify a confirmed write as readonly."""
    params: dict[str, object] = {"type": "object", "properties": {}}

    plain = OpSpec(name="probe", description="a probe", params=params)
    assert plain.sync_result is False

    sync = OpSpec(
        name="probe",
        description="a probe",
        params=params,
        readonly=True,
        sync_result=True,
    )
    assert sync.sync_result is True

    confirmed_write = OpSpec(
        name="confirm_project_action",
        description="confirm a pending project action",
        params=params,
        sync_result=True,
    )
    assert confirmed_write.readonly is False
    assert confirmed_write.sync_result is True

    assert SEARCH.sync_result is True


def test_bind_delegate_inherits_the_routing_class_from_the_wake_reason() -> None:
    """The routing class is inherited along the causal chain, not reverse-derived from origin_ref (R12).

    **Fixed origin, varied wake** — one half of it. The other half (fixed wake, varied origin) is in
    the two cases below; only once each variable is pinned separately is the claim "routing class is
    a function of origin_ref" truly ruled out (R45).
    """
    ambient = WakeReason(kind="handoff", priority=50, routing_class="ambient")

    awaited_delegate = bind_delegate(
        DIM_LIGHT, wake_reason=USER_WAKE, op=SET_LIGHT, now=0.0, delegate_id="d-1"
    )
    ambient_delegate = bind_delegate(
        DIM_LIGHT, wake_reason=ambient, op=SET_LIGHT, now=0.0, delegate_id="d-2"
    )

    assert awaited_delegate.routing_class == "user_awaited"
    assert ambient_delegate.routing_class == "ambient"
    assert (
        awaited_delegate.origin_ref == ambient_delegate.origin_ref
    )  # same origin, different routing


# ---- The routing class is not a function of origin_ref: one case per direction (R45) ----
#
# The phenomenon codex #36 reported is real: a trace can show `origin_ref=ambient_sim:1` paired
# with `routing_class=user_awaited`. But those two fields answer different questions —
# `origin_ref` answers "what is this activity answering, for whom" (written by the model, causal
# bookkeeping); `routing_class` answers "who's waiting when the result comes back" (bound at
# runtime along the wake chain, interrupt eligibility).
# The one driving the wake loop and the one the model is currently answering can already be
# different people, so the two disagreeing is **legal**.
#
# What would be fatal is wiring them together: the moment routing class becomes a function of
# `origin_ref`, interrupt eligibility falls onto a field the model fills in itself — exactly the
# two things 05-executors.md line 102 calls out to block.


def test_a_model_written_origin_cannot_silence_a_result_the_user_is_waiting_for() -> None:
    """The downward direction = **self-silencing**.

    The user asks something -> FastBrain, while dispatching, writes `origin_ref` as an ambient
    observation (a hallucination, or drift from context text nearby, either is enough). If routing
    class followed origin, this activity's result would go into the suggestion pool, and **the
    user's question would from then on have no follow-up** — exactly what "dispatch always has a
    follow-up" is supposed to guarantee.
    """
    at_ambient_origin = bind_delegate(
        replace(DIM_LIGHT, origin_ref="ambient_sim:1"),
        wake_reason=USER_WAKE,
        op=SET_LIGHT,
        now=0.0,
        delegate_id="d-1",
    )

    assert (
        at_ambient_origin.origin_ref == "ambient_sim:1"
    )  # causal bookkeeping records exactly what was written
    assert (
        at_ambient_origin.routing_class == "user_awaited"
    )  # interrupt eligibility still follows the wake chain


def test_a_model_written_origin_cannot_promote_a_proactive_dispatch() -> None:
    """The upward direction = **self-promotion**, also option (4) ruled out by R36.

    The legal shape of the proactive path: an ambient observation wakes the Surrogate -> it picks a
    suggestion -> a second-hop wake reaches FastBrain (inheriting the first hop's routing class, no
    promotion) -> FastBrain dispatches an activity, and that activity happens to reference an old
    user utterance (referencing it is **correct**, that really is what it's answering).
    If routing class followed origin, an unsolicited proactive remark would gain the right to
    interrupt the user just by way of an `origin_ref`.

    This is also the exact spot where the plan's `max(inherited, derived-from-origin)` was
    disproven by its own probe: "only ever raising it" sounds safe, but the promotion itself is half the harm.
    """
    proactive = WakeReason(kind=SELECTED_WAKE_KIND, priority=10, routing_class="ambient")

    at_user_origin = bind_delegate(
        DIM_LIGHT,  # origin_ref="conversation:1", a user utterance
        wake_reason=proactive,
        op=SET_LIGHT,
        now=0.0,
        delegate_id="d-1",
    )

    assert at_user_origin.origin_ref == "conversation:1"
    assert at_user_origin.routing_class == "ambient"


# ---- An executor states only the outcome, never who it is (R46) ----
#
# codex #32's two cases: forging `delegate_id="d-999"` + `trust="trusted_user"` was accepted as-is;
# a nonexistent `channel` caused `memory.policies[...]` to KeyError and kill the whole Runtime on
# the spot. The two share a root cause — identity was never the adapter's to state in the first place.


def test_handoff_cannot_claim_an_identity_of_its_own() -> None:
    """The list an adapter simply can't reach, enforced through the type (the same move R17 makes on the executor side).

    ts / seq were already out of reach; delegate_id / channel / origin_ref are the ones reclaimed
    this round. "Which delegate a result belongs to" is something the main loop **already knows at
    dispatch time** — asking the executor again only gives it a chance to get it wrong, and when it
    does, the damage isn't to this observation, it's to someone else's activity.
    """
    handoff = Handoff(outcome="ok", trust="trusted_system", content={})

    for forgeable in ("ts", "seq", "delegate_id", "channel", "origin_ref"):
        assert not hasattr(handoff, forgeable)


def test_an_executor_cannot_claim_to_be_the_user() -> None:
    """`trust` is left for the adapter to declare, but `trusted_user` isn't in its vocabulary.

    trust carries no gate, so this isn't a security barrier, it's **not letting the blackboard tell
    lies**: an observation fed back by an executor and labeled `trusted_user` reads, to FastBrain,
    as the user having said something again — when actually it's the executor that made it up.

    The twin case is the second assertion: `untrusted_external` still passes through unchanged.
    Without it, "always rewrite to trusted_system" would also pass the first assertion, and that
    would relabel a page fetched by search as our own device state.
    """
    delegate = bind_delegate(
        DIM_LIGHT, wake_reason=USER_WAKE, op=SET_LIGHT, now=0.0, delegate_id="d-1"
    )

    def trust_of(declared: str) -> str:
        return _handoff_event(Handoff(outcome="ok", trust=declared, content={}), delegate).trust

    assert trust_of("trusted_user") == "trusted_system"  # impersonation: rewritten
    assert trust_of("untrusted_external") == "untrusted_external"  # stated source: accepted as-is
    # Literal can't be enforced at runtime (R41), so unrecognized values need a destination too, instead of passing through onto the blackboard as-is.
    assert trust_of("boss") == "trusted_system"


async def test_an_adapter_that_raises_leaves_an_unknown_not_a_dead_runtime() -> None:
    """Contract one says "dispatch never raises", but the main loop can't just trust that.

    Before the fix: an adapter raises a RuntimeError -> `_reap` holds onto it -> the loop crashes
    on the spot, taking down other in-flight activities that had nothing to do with it. The contract
    governs how an executor should be written; this one governs what happens when it isn't.

    `unknown` is not `failed`: the adapter blew up partway through, and whether the light actually got dimmed is something we genuinely don't know.
    """
    clock = VirtualClock()
    memory = Memory(policies=SIM_POLICIES)
    brain = ScriptedFastBrain(
        [
            FastBrainOutput(
                speak=SpeakOutput(act="say", text="好，这就去调"),
                action=ActionOutput(act="delegate", delegate=DIM_LIGHT),
            )
        ],
        clock=clock,
    )
    runtime = Runtime(
        clock=clock, memory=memory, fastbrain=brain, executors={"slow_sim": _BoomSim()}
    )
    runtime.post(UserInput(text="把客厅灯调暗点"))

    await runtime.run()  # runs to completion; the exception doesn't leak out

    (result,) = memory.channels["slow_sim"].items
    assert (
        result.outcome == "unknown"
    )  # not failed: an exception isn't evidence that "this didn't happen"
    assert result.content["exception"] == "RuntimeError"
    # Identity is bound from the dispatch record, so even the call that blew up knows who it's answering — "dispatch always has a follow-up".
    assert result.refs[0] == "conversation:1"
    assert len(brain.views) == 2  # and the model really was woken and told


async def _run_dispatching(adapter: Any) -> Memory:
    """Dispatch one activity to this executor, run the whole Runtime to completion, and hand back the blackboard.

    `test_an_adapter_that_raises...` sets this up itself because it also needs to look at
    `brain.views`; here we only care what got left on the blackboard.
    """
    clock = VirtualClock()
    memory = Memory(policies=SIM_POLICIES)
    brain = ScriptedFastBrain(
        [
            FastBrainOutput(
                speak=SpeakOutput(act="say", text="好，这就去调"),
                action=ActionOutput(act="delegate", delegate=DIM_LIGHT),
            )
        ],
        clock=clock,
    )
    runtime = Runtime(clock=clock, memory=memory, fastbrain=brain, executors={"slow_sim": adapter})
    runtime.post(UserInput(text="把客厅灯调暗点"))
    await runtime.run()
    return memory


async def test_a_bad_return_value_is_an_unknown_too_not_only_a_raised_exception() -> None:
    """The guard covers the whole "adapter's return -> one event" span, not just that one await (added by codex review).

    The previous case only ever probed with `RuntimeError`, so two things went unpinned at the time, each mutation-tested fully green:

    - Shrinking `except Exception` to `except RuntimeError` — 205 cases, not one goes red.
      And the most common failure on a real executor is precisely not `RuntimeError`: attribute
      access on `None`, looking up an unhashable value in an allowlist — both different types.
    - `_handoff_event` used to run **outside** the guard (inside the spawn lambda), so these two
      cases could take down the loop without even raising — they blow up at the conversion step, and the try didn't cover that.

    `content["exception"]` asserts the stable cross-language contract classification. The malformed
    value itself and language-specific conversion error stay out of durable Memory.
    """
    cases = (
        (None, "ExecutorContractError"),
        (
            Handoff(outcome="ok", trust=[], content={}),
            "ExecutorContractError",
        ),
    )
    for handed_in, expected in cases:
        memory = await _run_dispatching(_WrongSim(handed_in))

        (result,) = memory.channels["slow_sim"].items
        assert result.outcome == "unknown"  # Runtime runs to completion, and leaves a record
        assert result.content["exception"] == expected
        assert result.content["detail"] == "invalid_executor_output"
        assert (
            result.refs[0] == "conversation:1"
        )  # identity is still bound from the dispatch record, not read from that bad return value


async def test_a_content_that_cannot_be_recorded_never_reaches_the_channel() -> None:
    """The two cases above blow up at the **conversion** step; this one blows up **after** conversion — one beat later, while compiling the view (R55).

    When `content` isn't a mapping, `_handoff_event` used to never read a single character of it,
    so it fell into the blackboard as-is. What actually reads it is `context_view`'s
    `dict(item.content)`, and that's already the next hop's business: the guard has long since
    exited, the exception comes out of the main loop, **and it stays on the channel** — every
    subsequent view compilation blows up on that same item, and the loop never comes back up. So
    the last assertion is this case's real point, not the `exception` field's name.

    The fix is to move `dict()` inside the guard: reading it there is exactly asking "can this be
    recorded?" — and if the answer is no, it goes through the existing normalization path and becomes an `unknown`.
    **Not** field-by-field validation of the adapter's output (R46 already ruled that out): `outcome`
    and `refs` still pass through as-is, a bad value is just an observation; the question here is
    only "can it be recorded", that's where the line is drawn.
    """
    memory = await _run_dispatching(
        _WrongSim(Handoff(outcome="ok", trust="trusted_system", content="一句话"))
    )

    (result,) = memory.channels["slow_sim"].items
    assert result.outcome == "unknown"
    assert result.content["exception"] == "ExecutorContractError"
    assert result.content["detail"] == "invalid_executor_output"
    # The channel isn't poisoned: compile a view again at a different instant, and it still compiles fine.
    assert compile_context_view(memory, floor="idle", now=99.0).channels


async def test_an_adapter_cannot_drift_the_dedup_key_through_its_own_context() -> None:
    """`ctx.delegate` has to be the executor's **own copy**; mutating it must not reach the ledger (R54).

    `bind_delegate` copies `request` for exactly this reason, but `DispatchContext` used to hand
    over the very delegate object from the ledger — `Delegate` is frozen, and `replace` can't swap
    out the dict sitting on it. So the copy-on-that-door fix was done, and the adapter reached in
    through a different door with the same effect.

    The consequence lands on two fences, both of which compare "the whole request being equal":
    once the key has drifted, neither R28's in-flight dedup nor R49's unknown fence recognizes the
    same thing being dispatched again. And this activity happens to land on `unknown` — the exact field for "we don't know whether it actually happened", the one that least deserves being resent as-is.
    """
    clock = VirtualClock()
    adapter = _MeddlingSim()
    brain = ScriptedFastBrain(
        [
            FastBrainOutput(
                speak=SpeakOutput(act="say", text="好，这就去调"),
                action=ActionOutput(act="delegate", delegate=DIM_LIGHT),
            )
        ],
        clock=clock,
    )
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=SIM_POLICIES),
        fastbrain=brain,
        executors={"slow_sim": adapter},
    )
    runtime.post(UserInput(text="把客厅灯调暗点"))

    await runtime.run()

    # It really did change it to 999 (otherwise this case would be asking nothing), just on its own copy.
    assert adapter.seen == {"room": "客厅", "brightness": 999}
    stored = runtime.delegates.find("d-1")
    assert stored is not None and stored.request == {"room": "客厅", "brightness": 30}
    # The fence still recognizes this activity; the drifted value doesn't correspond to anything that was ever actually dispatched.
    fence = runtime.delegates.unresolved_duplicate_of
    assert fence("slow_sim", "set_light", {"room": "客厅", "brightness": 30}) is not None
    assert fence("slow_sim", "set_light", {"room": "客厅", "brightness": 999}) is None


async def test_a_cancelled_dispatch_leaves_no_fake_i_dont_know() -> None:
    """The **upper bound** of the case above: `except Exception` doesn't catch `CancelledError`, which is a BaseException.

    This boundary was likewise disproven by mutation testing: changing it to `except BaseException`
    left 205 cases not one red, while the statement "cancelling an in-flight job at shutdown must
    not leave a fake 'we don't know' on the blackboard" was, at the time, only a line in a docstring.

    **This pins down the function, not that cancellation actually happens somewhere in the production
    chain today**: nothing calls `task.cancel()` today (R25 explicitly ruled out using it to "cancel
    a dispatch attempt"), `run()` just waits for the queue to drain naturally. So cancellation is
    only questioned directly here; once there's an actual shutdown path, that other half needs to be questioned again on its own chain.
    """

    class _CancelledSim:
        def __init__(self) -> None:
            self.manifest = ExecutorManifest(
                name="slow_sim", ops=(SET_LIGHT,), policy=SLOW_SIM_POLICY
            )

        async def dispatch(self, op: str, request: dict[str, Any], ctx: DispatchContext) -> Handoff:
            raise asyncio.CancelledError

    delegate = bind_delegate(
        DIM_LIGHT, wake_reason=USER_WAKE, op=SET_LIGHT, now=0.0, delegate_id="d-1"
    )
    ctx = DispatchContext(clock=VirtualClock(), delegate=delegate)

    with pytest.raises(asyncio.CancelledError):
        await _dispatch_guarded(_CancelledSim(), delegate, ctx)


def test_an_executor_wired_under_the_wrong_name_is_caught_at_assembly() -> None:
    """The previous case's "KeyError degrades into a startup-time config error" needs someone to actually check it at startup (added by codex review).

    Without this validation, a wiring mistake doesn't fail assembly — it blows up **at runtime,
    behind a side effect**: `_apply_handoff` first calls `terminate`, moving that activity out of the
    in-flight table, and only the next line, `policies[...]`, KeyErrors — so that activity ends up
    with neither a result nor an in-flight entry, and the loop dies too.

    The second failure mode is quieter: when `manifest.name` differs from the channel name,
    `_probes`'s `by_name` never matches, and R31's entire recheck chain silently never surfaces. So
    all three get checked together, not just whether the blackboard recognizes the name.

    The two error cases each pick a shape that **commits only that one mistake**, otherwise checking
    half of it would also go fully green — mutation testing showed: if the first case hung on a key
    the blackboard doesn't recognize (`"slowsim"`), deleting the half that checks the three names
    matching would still pass green.
    """
    clock = VirtualClock()
    memory = Memory(policies=SIM_POLICIES)

    with pytest.raises(
        ValueError
    ):  # the key is a **legitimate channel**, just wired into the wrong slot
        Runtime(clock=clock, memory=memory, executors={"fast_sim": _BoomSim()})

    elsewhere = _BoomSim()
    elsewhere.manifest = ExecutorManifest(
        name="ghost", ops=(SET_LIGHT,), policy=replace(SLOW_SIM_POLICY, channel="ghost")
    )
    with pytest.raises(
        ValueError
    ):  # the three fields are self-consistent, but that channel doesn't exist on the blackboard
        Runtime(clock=clock, memory=memory, executors={"ghost": elsewhere})

    # Reverse twin: wiring it right shouldn't be blocked. Without it, "constructing Runtime always raises" would also pass the two cases above.
    Runtime(clock=clock, memory=memory, executors={"slow_sim": _BoomSim()})
    # And the reverse doesn't need to hold symmetrically: `ambient` is a channel with no executor, and that shouldn't fail assembly.
    Runtime(clock=clock, memory=Memory(policies=(*SIM_POLICIES, AMBIENT_POLICY)))


def test_loaded_nonreadonly_executor_count_must_be_exactly_one() -> None:
    """D19 counts manifest behavior, so readonly search does not consume the active slot."""

    readonly = SearchAdapter(object())  # dispatch is never reached in this startup-only case
    clock = VirtualClock()

    with pytest.raises(ValueError, match="non-readonly.*0"):
        Runtime(
            clock=clock,
            memory=Memory(policies=(SEARCH_POLICY,)),
            executors={"search": readonly},
        )

    Runtime(
        clock=clock,
        memory=Memory(policies=(SEARCH_POLICY, SLOW_SIM_POLICY)),
        executors={"search": readonly, "slow_sim": SlowSim()},
    )

    with pytest.raises(ValueError, match="non-readonly.*2"):
        Runtime(
            clock=clock,
            memory=Memory(policies=(SEARCH_POLICY, FAST_SIM_POLICY, SLOW_SIM_POLICY)),
            executors={
                "search": readonly,
                "fast_sim": FastSim(),
                "slow_sim": SlowSim(),
            },
        )

    explicit = Runtime(
        clock=clock,
        memory=Memory(policies=(SEARCH_POLICY, FAST_SIM_POLICY, SLOW_SIM_POLICY)),
        executors={
            "search": readonly,
            "fast_sim": FastSim(),
            "slow_sim": SlowSim(),
        },
        expected_active_executors=frozenset({"fast_sim", "slow_sim"}),
    )
    assert set(explicit.executors) == {"search", "fast_sim", "slow_sim"}

    with pytest.raises(ValueError, match="必须与显式配置完全一致"):
        Runtime(
            clock=clock,
            memory=Memory(policies=(FAST_SIM_POLICY,)),
            executors={"fast_sim": FastSim()},
            expected_active_executors=frozenset({"fast_sim", "slow_sim"}),
        )


def test_the_same_channel_may_not_carry_two_different_policies() -> None:
    """Matching names isn't enough: the blackboard's policy and the manifest's policy must be equal **by value** (R51).

    "The sole authority is `ExecutorManifest.policy`" is written in `memory/policy.py` and
    `glossary.md`, but what the runtime actually reads has always been `memory.policies[channel]`.
    The day these two values diverge, not a single assertion would go red (added by codex review) —
    every failure mode is silent: `typical_latency` drifting means `eta` keeps lying to FastBrain;
    `priority` drifting means merged wakes pick the wrong winner; `wake` drifting means the `ambient`
    slot ends up somewhere the manifest never declared.

    The second block is the **reverse twin, and this case's real discriminating power**: two values
    that are equal but not identical must still be allowed through. An implementation written as
    `installed is not manifest.policy` would pass the first block and fail the second — and the
    fixtures today happen to share the very same constant objects (`tests/policies.py` is a
    re-export), so with only the first block, identity comparison and value comparison would both be equally green.
    """
    clock = VirtualClock()

    drifted = Memory(policies=(FAST_SIM_POLICY, replace(SLOW_SIM_POLICY, typical_latency=99.0)))
    with pytest.raises(ValueError, match="两份"):
        Runtime(clock=clock, memory=drifted, executors={"slow_sim": _BoomSim()})

    equal_but_distinct = Memory(policies=(FAST_SIM_POLICY, replace(SLOW_SIM_POLICY)))
    Runtime(clock=clock, memory=equal_but_distinct, executors={"slow_sim": _BoomSim()})


async def test_scripted_fast_brain_streams_text_before_the_action() -> None:
    """The fake fires in the arrival order seen in the spike: text finishes streaming out -> only then does the action axis arrive, and the text is **multi-chunk**.

    Note this must **run inside the runtime**: virtual time only advances via the loop, and
    directly awaiting a `clock.sleep()` outside the loop hangs forever (that's exactly the price of the determinism 06-verification.md wants).
    """
    clock = VirtualClock()
    memory = Memory(policies=SIM_POLICIES)
    brain = ScriptedFastBrain(
        [
            FastBrainOutput(
                speak=SpeakOutput(act="say", text="好的，我这就去调，顺便说说电影"),
                action=ActionOutput(act="delegate", delegate=DIM_LIGHT),
            )
        ],
        clock=clock,
    )
    view = compile_context_view(memory, floor="idle", now=0.0)
    deltas: list[object] = []

    async def drain() -> CallRecord:
        async for delta in brain.call(view):
            deltas.append(delta)
        # This only borrows the loop to advance virtual time; consuming the two axes is out of
        # scope for observation here. But since B1, model_done needs to fetch a CallRecord from the
        # job table, so the product gets a minimal valid one (see fakes.finished_call).
        return finished_call()

    runtime = Runtime(clock=clock, memory=memory)
    runtime.spawn(drain(), lambda job_id, _result: ModelDone(slot="fast", job_id=job_id))
    await runtime.run()

    text_deltas = [index for index, delta in enumerate(deltas) if isinstance(delta, TextDelta)]
    action_deltas = [index for index, delta in enumerate(deltas) if isinstance(delta, ActionDelta)]
    assert (
        len(text_deltas) > 1
    )  # multi-chunk: lets an implementation that "buffers the whole stream" show itself
    assert max(text_deltas) < min(action_deltas)  # all text comes before the action
    assert "".join(delta.text for delta in deltas if isinstance(delta, TextDelta)) == (
        "好的，我这就去调，顺便说说电影"
    )
    assert brain.views == [view]


# ---- One call recognizes only one action (R47) ----
#
# codex #33: two `ActionDelta`s overwrite each other one by one, and the last one silently wins. A
# real provider's `tool_calls` is an array, and "two in one turn" is a shape it can naturally
# express, so this isn't a hypothetical degenerate implementation. The cost of overwriting is that
# the earlier ones leave no record at all — another way of writing "dispatched an activity, then
# there's no follow-up", except here half the request was never dispatched in the first place.

_ROOMS = ("客厅", "卧室", "书房")


class _MultiActionFastBrain:
    """Each time it's woken, emits as many action-axis deltas as the matching entry in `counts`.

    **Once the script runs out, it repeats the last entry instead of going silent**: going silent
    would paper over a self-waking loop too — the second wake in the loop does nothing, so it looks
    like there's no loop (the lesson from R30's case).
    """

    def __init__(self, *counts: int, clock: VirtualClock) -> None:
        self._counts = counts
        self._clock = clock
        self.calls = 0

    async def call(self, view: ContextView) -> AsyncIterator[FastBrainDelta]:
        self.calls += 1
        count = self._counts[min(self.calls - 1, len(self._counts) - 1)]
        await self._clock.sleep(0.1)
        yield TextDelta(text="好，这就去办")
        for index in range(count):
            yield ActionDelta(
                action=ActionOutput(
                    act="delegate",
                    delegate=replace(DIM_LIGHT, request={"room": _ROOMS[index], "brightness": 30}),
                )
            )


async def _run_actions(*counts: int) -> tuple[Runtime, _MultiActionFastBrain]:
    """ "Dim both the living room and bedroom lights" — one utterance, two rooms, exactly the shape where a model would emit two tool_calls."""
    clock = VirtualClock()
    brain = _MultiActionFastBrain(*counts, clock=clock)
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=SIM_POLICIES),
        fastbrain=brain,
        executors={"slow_sim": SlowSim()},
    )
    runtime.post(UserInput(text="把客厅和卧室的灯都调暗"))

    await runtime.run(max_steps=200)

    return runtime, brain


def _failed(runtime: Runtime) -> list[MemoryItem]:
    return [
        item
        for item in runtime.memory.channels[CONVERSATION_CHANNEL].items
        if item.outcome == "failed"
    ]


async def test_a_second_action_in_one_call_is_refused_instead_of_overwriting_the_first() -> None:
    """Two actions -> **neither gets executed** + one failed observation + wake the model to try again.

    Before the fix, this silently kept only the bedroom one: the living room light never comes on,
    and nothing on the blackboard says "someone wanted the living room". Doing it half right is
    harder to notice than doing none of it — so it's better to do none of it, and let next turn's
    model see "you gave two last turn, I executed neither".

    `max_steps` is **part of the assertion**, not a safety fuse: this FastBrain never goes silent,
    so if the brake (R30) doesn't kick in, the case will hit the step limit and fail on `calls == 2`.
    """
    runtime, brain = await _run_actions(2)

    assert runtime.delegates.snapshot() == ()  # nothing entered the in-flight table
    assert (
        runtime.memory.channels["slow_sim"].items == ()
    )  # nothing happened on the executor's side
    assert [event.KIND for event in runtime.applied if event.KIND == "deadline"] == []

    failed = _failed(runtime)
    assert [item.content["error"] for item in failed] == ["multiple_actions"] * 2
    assert failed[0].content["count"] == 2
    # The first wake comes from user input, the second from that rejection's compensation. A third would be the loop (shares R30's brake).
    assert brain.calls == 2


async def test_the_refusal_reports_how_many_actions_there_were_not_just_that_there_were_many() -> (
    None
):
    """`count` has to be the **exact number**, not the boolean "more than one" (added by codex review).

    The previous case only ever tested exactly two, and `_ROOMS` only had two slots at the time — a
    three-action situation **couldn't be constructed**. So the mutation `extra_actions =
    int(len(actions) > 1)` didn't go red once at the time: in a world where the only values are 2
    and 1, a count and a boolean are equal everywhere.

    The count isn't decoration. Next turn's model reads either "you gave 3 last turn, I executed
    none of them" or "you gave more than one last turn" — the former it can go split back into 3
    dispatches, the latter it only knows it made a mistake.
    """
    runtime, brain = await _run_actions(3)

    assert runtime.delegates.snapshot() == ()  # still none of the three get executed
    (first, _) = _failed(runtime)
    assert first.content["count"] == 3
    assert brain.calls == 2  # the brake still compensates only once


async def test_a_single_action_still_dispatches() -> None:
    """Reverse twin: with just one action, it still dispatches as normal.

    Without it, "always refuse the action axis" would also pass the case above — and that would silently shut off the entire action axis.
    """
    runtime, brain = await _run_actions(1, 0)

    assert runtime.delegates.terminated_by("d-1") == "handoff"
    assert [item.outcome for item in runtime.memory.channels["slow_sim"].items] == ["ok"]
    assert _failed(runtime) == []
    assert brain.calls == 2  # the second call is the handoff waking it to report the result
