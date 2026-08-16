from __future__ import annotations

from typing import Any

import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.events import HandoffEvent, ObservationEvent, UserInput, WakeReason
from nova_audio_agent.executors.watcher import GUARD_POLICY, WATCH_POLICY
from nova_audio_agent.memory import Memory
from nova_audio_agent.ports import (
    Delegate,
    DelegateRequest,
    DispatchContext,
    ExecutorManifest,
    Handoff,
    ObservationPayload,
    OpSpec,
)
from nova_audio_agent.runtime import Runtime, wake_targets
from fakes import ScriptedCompressor


def _runtime(
    *,
    channel: str = "watch",
    routing_class: str = "ambient",
) -> Runtime:
    policy = WATCH_POLICY if channel == "watch" else GUARD_POLICY
    runtime = Runtime(clock=VirtualClock(), memory=Memory(policies=(policy,)))
    runtime.delegates.dispatch(
        Delegate(
            delegate_id="d-1",
            executor=channel,
            op="start",
            request={"condition": "白纸"},
            origin_ref="conversation:1",
            deadline=1800.0,
            routing_class=routing_class,  # type: ignore[arg-type]
            dispatched_at=0.0,
        )
    )
    return runtime


def _observation(**overrides: object) -> ObservationEvent:
    values: dict[str, object] = {
        "channel": "watch",
        "delegate_id": "d-1",
        "op": "start",
        "origin_ref": "conversation:1",
        "trust": "untrusted_external",
        "content": {
            "state": "hit",
            "hit": True,
            "condition": "白纸",
            "observation": "画面中出现白纸",
            "hit_count": 1,
        },
        "ts": 1.0,
        "seq": 2,
    }
    values.update(overrides)
    return ObservationEvent(**values)  # type: ignore[arg-type]


def test_watch_hit_appends_without_termination_and_wakes_surrogate() -> None:
    runtime = _runtime()
    event = _observation()

    runtime.apply(event)
    targets = wake_targets(event, runtime.memory, ledger=runtime.delegates)

    item = runtime.memory.channels["watch"].items[-1]
    assert item.content == event.content
    assert item.trust == "untrusted_external"
    assert item.refs == ("conversation:1",)
    assert runtime.delegates.in_flight_delegate("d-1") is not None
    assert runtime.delegates.terminated_by("d-1") is None
    suggestion = runtime.suggestions.all()[0]
    assert suggestion.content == event.content
    assert suggestion.evidence_refs == (item.ref,)
    assert targets[0][0] == "surrogate.watch"
    assert targets[0][1].routing_class == "ambient"
    assert targets[0][1].origin == "d-1"


def test_lifecycle_observation_is_board_evidence_without_wake_or_suggestion() -> None:
    runtime = _runtime()
    event = _observation(
        trust="trusted_system",
        content={"state": "armed", "condition": "白纸", "hit_count": 0},
    )

    runtime.apply(event)

    assert runtime.memory.channels["watch"].items[-1].content["state"] == "armed"
    assert runtime.suggestions.all() == ()
    assert wake_targets(event, runtime.memory, ledger=runtime.delegates) == ()


@pytest.mark.asyncio
async def test_lifecycle_observations_keep_the_existing_compression_watermark() -> None:
    clock = VirtualClock()
    compressor = ScriptedCompressor(clock=clock)
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=(WATCH_POLICY,)),
        compressor=compressor,
    )
    runtime.delegates.dispatch(
        Delegate(
            delegate_id="d-1",
            executor="watch",
            op="start",
            request={"condition": "白纸"},
            origin_ref="conversation:1",
            deadline=1800.0,
            routing_class="ambient",
            dispatched_at=0.0,
        )
    )

    for index in range(WATCH_POLICY.compress_watermark):
        event = _observation(
            trust="trusted_system",
            content={"state": "armed", "condition": "白纸", "hit_count": 0},
            seq=index + 2,
            ts=float(index + 1),
        )
        runtime.apply(event)
        assert wake_targets(event, runtime.memory, ledger=runtime.delegates) == ()

    await runtime.run()

    assert len(compressor.compressed) == 1
    assert len(compressor.compressed[0]) == WATCH_POLICY.compress_watermark
    assert runtime.suggestions.all() == ()


def test_second_hit_gets_fresh_suggestion_without_rearming_spoken_hit() -> None:
    runtime = _runtime()
    first = _observation(seq=2, ts=1.0)
    second = _observation(
        seq=3,
        ts=62.0,
        content={
            "state": "hit",
            "hit": True,
            "condition": "白纸",
            "observation": "白纸再次出现",
            "hit_count": 2,
        },
    )

    runtime.apply(first)
    first_suggestion = runtime.suggestions.all()[0]
    runtime.suggestions.fire(first_suggestion.id, now=1.0, cooldown=60.0)
    runtime.apply(second)

    first_after, second_suggestion = runtime.suggestions.all()
    assert first_after.status == "fired"
    assert second_suggestion.status == "pending"
    assert second_suggestion.id != first_suggestion.id
    assert second_suggestion.content["hit_count"] == 2
    refs = [item.ref for item in runtime.memory.channels["watch"].items]
    assert refs == ["watch:1", "watch:2"]


def test_second_hit_withdraws_the_same_monitor_pending_suggestion() -> None:
    runtime = _runtime()
    first = _observation(seq=2, ts=1.0)
    second = _observation(
        seq=3,
        ts=4.0,
        content={
            "state": "hit",
            "hit": True,
            "condition": "白纸",
            "observation": "白纸再次出现",
            "hit_count": 2,
        },
    )

    runtime.apply(first)
    first_suggestion = runtime.suggestions.all()[0]
    runtime.apply(second)

    first_after, second_suggestion = runtime.suggestions.all()
    assert first_after.id == first_suggestion.id
    assert first_after.status == "withdrawn"
    assert second_suggestion.status == "pending"
    offered = [
        item.ref
        for item in runtime.compile_view(trigger_kind="observation").affordances
        if item.source == "suggestion"
    ]
    assert offered == [second_suggestion.id]


def test_guard_hit_wakes_fast_without_suggestion() -> None:
    runtime = _runtime(channel="guard", routing_class="user_awaited")
    event = _observation(channel="guard")

    runtime.apply(event)
    targets = wake_targets(event, runtime.memory, ledger=runtime.delegates)

    assert runtime.suggestions.all() == ()
    assert targets[0][0] == "fast"
    assert targets[0][1].priority == 90
    assert targets[0][1].routing_class == "user_awaited"


@pytest.mark.parametrize(
    "overrides",
    [
        {"channel": "guard"},
        {"op": "status"},
        {"origin_ref": "conversation:2"},
        {"delegate_id": "d-unknown"},
    ],
)
def test_wrong_observation_identity_cannot_write_or_wake(
    overrides: dict[str, object],
) -> None:
    runtime = _runtime()
    event = _observation(**overrides)

    runtime.apply(event)

    assert runtime.memory.channels["watch"].items == ()
    assert runtime.suggestions.all() == ()
    assert wake_targets(event, runtime.memory, ledger=runtime.delegates) == ()


def test_post_terminal_observation_cannot_write_or_wake() -> None:
    runtime = _runtime()
    terminal = HandoffEvent(
        channel="watch",
        delegate_id="d-1",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={"hit": False, "reason": "stopped"},
    )
    runtime.apply(terminal)
    before = tuple(runtime.memory.channels["watch"].items)
    event = _observation(seq=4, ts=2.0)

    runtime.apply(event)

    assert runtime.memory.channels["watch"].items == before
    assert wake_targets(event, runtime.memory, ledger=runtime.delegates) == ()


@pytest.mark.asyncio
async def test_dispatch_context_binds_observation_identity_and_clamps_trust() -> None:
    start = OpSpec(
        name="start",
        description="watch",
        params={"type": "object", "properties": {}},
        readonly=True,
        deadline_budget=30.0,
    )

    class ObservingAdapter:
        manifest = ExecutorManifest(name="watch", ops=(start,), policy=WATCH_POLICY)

        async def dispatch(
            self,
            op: str,
            request: dict[str, Any],
            ctx: DispatchContext,
        ) -> Handoff:
            del request
            assert op == "start"
            assert ctx.observe is not None
            ctx.observe(
                ObservationPayload(
                    trust="trusted_user",
                    content={"state": "armed", "nested": {"coords": (1, 2)}},
                )
            )
            return Handoff(
                outcome="ok",
                trust="trusted_system",
                content={"hit": False, "reason": "stopped"},
            )

    runtime = Runtime(
        clock=VirtualClock(),
        memory=Memory(policies=(WATCH_POLICY,)),
        executors={"watch": ObservingAdapter()},
        expected_active_executors=frozenset(),
    )
    # Establish a valid causal origin before external dispatch.
    runtime.apply(UserInput("监控白纸", ts=0.0, seq=1))
    result = runtime.dispatch_external(
        DelegateRequest(
            executor="watch",
            op="start",
            request={},
            origin_ref="conversation:1",
        ),
        reason=WakeReason(kind="user_input", priority=100, routing_class="ambient"),
    )

    assert result.accepted is True
    await runtime.run()

    item = runtime.memory.channels["watch"].items[0]
    assert item.trust == "trusted_system"
    assert item.content == {"state": "armed", "nested": {"coords": [1, 2]}}
    observation = next(event for event in runtime.applied if isinstance(event, ObservationEvent))
    assert observation.delegate_id == result.delegate_id
    assert observation.channel == "watch"
    assert observation.op == "start"
    assert observation.origin_ref == "conversation:1"
