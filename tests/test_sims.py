"""Dispatch-contract tests for the two simulators implemented in A3.

This is **not** the adapter conformance suite from 06-verification.md. Its seven
parameterized checks must run against every adapter and belong in D0. These tests ask
only whether the two simulators written in Stage A satisfy their Stage A port
contract. For the same reason, they do not inspect manifest content; that belongs in
Stage C.

They enforce contract 1 from 05-executors.md: **dispatch never raises; bad output is
an observation.** They also distinguish outcomes. An implementation that always
returns `failed` would satisfy every "does not raise" assertion while violating the
rule that `unknown` must never be reported as `failed`.
"""

from __future__ import annotations

import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.events import WakeReason
from nova_audio_agent.executors.sims import SET_LIGHT, FastSim, SlowSim
from nova_audio_agent.memory import Memory
from nova_audio_agent.ports import DelegateRequest, DispatchContext, bind_delegate
from nova_audio_agent.runtime import Runtime, _handoff_event
from policies import SIM_POLICIES

DIM_LIGHT = {"room": "客厅", "brightness": 30}
USER_WAKE = WakeReason(kind="user_input", priority=100, routing_class="user_awaited")


def _ctx(
    clock: VirtualClock, *, executor: str = "slow_sim", op: str = "set_light"
) -> DispatchContext:
    delegate = bind_delegate(
        DelegateRequest(executor=executor, op=op, request=DIM_LIGHT, origin_ref="conversation:1"),
        wake_reason=USER_WAKE,
        op=SET_LIGHT,
        now=clock.now(),
        delegate_id="d-1",
    )
    return DispatchContext(clock=clock, delegate=delegate)


async def _dispatch(sim, op: str, request: dict, *, clock: VirtualClock):
    """Dispatch once through the runtime and return the handoff and final virtual time."""
    runtime = Runtime(clock=clock, memory=Memory(policies=SIM_POLICIES))
    ctx = _ctx(clock, executor=sim.manifest.name, op=op)
    job_id = runtime.spawn(
        sim.dispatch(op, request, ctx),
        # Identity is bound from the dispatch record, not carried by the handoff
        # (R46). Use the spine's real constructor so this test does not maintain a
        # shadow implementation that still recognizes `handoff.channel`.
        lambda job_id, handoff: _handoff_event(handoff, ctx.delegate),
    )
    await runtime.run()
    try:
        return runtime.result_of(job_id), clock.now()
    except KeyError:  # Hung: the job never completed.
        return None, clock.now()


async def test_happy_path_returns_ok() -> None:
    """Positive twin: reject an implementation that always returns `failed`."""
    clock = VirtualClock()

    handoff, finished_at = await _dispatch(FastSim(), "set_light", DIM_LIGHT, clock=clock)

    assert handoff.outcome == "ok"
    assert handoff.content == {"op": "set_light", **DIM_LIGHT}
    # This once asserted `handoff.channel` and `origin_ref`. After R46, simulators
    # cannot supply either; the spine binds the result to its delegate, which is
    # covered in test_ports.py.
    assert finished_at == pytest.approx(0.05)  # Millisecond-scale.


async def test_unknown_op_is_a_failed_observation_not_an_exception() -> None:
    clock = VirtualClock()

    handoff, _ = await _dispatch(SlowSim(), "launch_rocket", {}, clock=clock)

    assert handoff.outcome == "failed"  # It never happened.
    assert handoff.content["error"] == "unknown_op"


async def test_missing_required_param_is_failed() -> None:
    clock = VirtualClock()

    handoff, _ = await _dispatch(SlowSim(), "set_light", {"room": "客厅"}, clock=clock)

    assert handoff.outcome == "failed"
    assert handoff.content["problems"] == ["缺少必填参数 brightness"]


async def test_wrong_typed_param_is_failed_not_ok() -> None:
    """Treat a request with all fields but wrong types as not executed.

    Checking only required fields would give `brightness="very dim"` an `ok` outcome,
    changing the failure from uncertainty to a false success, exactly what this
    design most needs to avoid.
    """
    clock = VirtualClock()

    handoff, _ = await _dispatch(
        SlowSim(), "set_light", {"room": "客厅", "brightness": "很暗"}, clock=clock
    )

    assert handoff.outcome == "failed"
    assert handoff.content["problems"] == ["brightness 应为 integer"]


async def test_boolean_does_not_pass_as_an_integer() -> None:
    """Reject bool even though it is an int subclass accepted by `isinstance`."""
    clock = VirtualClock()

    handoff, _ = await _dispatch(
        SlowSim(), "set_light", {"room": "客厅", "brightness": True}, clock=clock
    )

    assert handoff.outcome == "failed"


async def test_timeout_is_unknown_not_failed() -> None:
    """A timeout is not evidence that the operation did not occur.

    The model owns the wording; this layer owns the outcome.
    """
    clock = VirtualClock()

    handoff, _ = await _dispatch(
        SlowSim(latency=5.0, inject="timeout"), "set_light", DIM_LIGHT, clock=clock
    )

    assert handoff.outcome == "unknown"
    assert handoff.content["error"] == "adapter_timeout"


async def test_transport_error_is_unknown_too() -> None:
    clock = VirtualClock()

    handoff, _ = await _dispatch(
        SlowSim(latency=5.0, inject="transport"), "set_light", DIM_LIGHT, clock=clock
    )

    assert handoff.outcome == "unknown"
    assert handoff.content["error"] == "transport_error"


async def test_a_hung_adapter_never_hands_off_and_never_raises() -> None:
    """Contain an adapter that hangs without returning even its own timeout.

    The spine remains stable but receives no handoff. The deadline timer ultimately
    contains this case under termination rule 2, implemented in B3.
    """
    clock = VirtualClock()

    handoff, finished_at = await _dispatch(
        SlowSim(latency=5.0, inject="hang"), "set_light", DIM_LIGHT, clock=clock
    )

    assert handoff is None  # No handoff.
    assert finished_at == 0.0  # It did not advance virtual time either.
