from __future__ import annotations

import math
from typing import Any

import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.events import Deadline, HandoffEvent, ProgressEvent, UserInput, WakeReason
from nova_audio_agent.executors.codex import CODEX_MANIFEST, CODEX_POLICY
from nova_audio_agent.memory import Memory
from nova_audio_agent.ports import (
    Delegate,
    DelegateRequest,
    DispatchContext,
    ExecutorManifest,
    Handoff,
    OpSpec,
    ProgressPayload,
)
from nova_audio_agent.runtime import Runtime, wake_targets
from nova_audio_agent.suggestions import DEFAULT_COOLDOWN, is_available
from policies import SLOW_SIM_POLICY


def _runtime(*, routing_class: str = "user_awaited", op: str = "run") -> Runtime:
    runtime = Runtime(clock=VirtualClock(), memory=Memory(policies=(SLOW_SIM_POLICY,)))
    runtime.delegates.dispatch(
        Delegate(
            delegate_id="d-1",
            executor="slow_sim",
            op=op,
            request={"condition": "cup"},
            origin_ref="conversation:1",
            deadline=60.0,
            routing_class=routing_class,  # type: ignore[arg-type]
            dispatched_at=0.0,
        )
    )
    return runtime


def _progress(**overrides: object) -> ProgressEvent:
    values: dict[str, object] = {
        "channel": "slow_sim",
        "delegate_id": "d-1",
        "op": "run",
        "phase": "started",
        "internal_activity": 0,
        "elapsed": 0.0,
        "ts": 1.0,
        "seq": 2,
    }
    values.update(overrides)
    return ProgressEvent(**values)  # type: ignore[arg-type]


def _codex_runtime(*, delegate_id: str = "d-codex") -> Runtime:
    class _CodexAdapter:
        manifest = CODEX_MANIFEST

        async def dispatch(self, op: str, request: dict[str, Any], ctx: DispatchContext) -> Handoff:
            del op, request, ctx
            raise AssertionError("the direct runtime fixture never dispatches")

    runtime = Runtime(
        clock=VirtualClock(),
        memory=Memory(policies=(CODEX_POLICY,)),
        executors={"codex": _CodexAdapter()},  # type: ignore[dict-item]
    )
    runtime.delegates.dispatch(
        Delegate(
            delegate_id=delegate_id,
            executor="codex",
            op="run",
            request={"prompt": "检查旧版"},
            origin_ref="conversation:1",
            deadline=180.0,
            routing_class="user_awaited",
            dispatched_at=0.0,
        )
    )
    return runtime


def _codex_progress(
    *,
    summary: str | None = "检查后确认旧版只把笔记保存在页面内存中",
    **overrides: object,
) -> ProgressEvent:
    values: dict[str, object] = {
        "channel": "codex",
        "delegate_id": "d-codex",
        "op": "run",
        "phase": "working",
        "internal_activity": 1,
        "elapsed": 2.0,
        "summary": summary,
        "ts": 1.0,
        "seq": 2,
    }
    values.update(overrides)
    return ProgressEvent(**values)  # type: ignore[arg-type]


def test_codex_policy_enables_semantic_progress_arbitration() -> None:
    assert CODEX_POLICY.progress_via_surrogate is True
    assert SLOW_SIM_POLICY.progress_via_surrogate is False


def test_codex_semantic_progress_appends_before_candidate_with_exact_evidence() -> None:
    runtime = _codex_runtime()
    event = _codex_progress(summary="检查后确认旧版只把笔记保存在页面内存中")

    runtime.apply(event)

    item = runtime.memory.channels["codex"].items[-1]
    suggestion = runtime.suggestions.all()[-1]
    assert item.ref == "codex:1"
    assert suggestion.content == {"summary": event.summary}
    assert suggestion.evidence_refs == (item.ref,)
    assert suggestion.expires_at == event.ts + DEFAULT_COOLDOWN
    assert runtime._latest_progress_suggestion == {"d-codex": suggestion.id}  # noqa: SLF001
    assert wake_targets(event, runtime.memory, ledger=runtime.delegates) == (
        (
            "surrogate.watch",
            WakeReason(
                kind="progress",
                priority=CODEX_POLICY.priority,
                routing_class="ambient",
                origin="d-codex",
            ),
        ),
    )


@pytest.mark.parametrize(
    "event",
    [
        _codex_progress(phase="started", internal_activity=0, elapsed=0.0, summary=None),
        _codex_progress(summary=None),
    ],
    ids=("started", "count_only"),
)
def test_codex_nonsemantic_progress_stays_memory_only(event: ProgressEvent) -> None:
    runtime = _codex_runtime()

    runtime.apply(event)

    assert len(runtime.memory.channels["codex"].items) == 1
    assert runtime.suggestions.all() == ()
    assert wake_targets(event, runtime.memory, ledger=runtime.delegates) == ()


def test_codex_progress_supersedes_only_its_own_pending_candidate() -> None:
    runtime = _codex_runtime()
    runtime.delegates.dispatch(
        Delegate(
            delegate_id="d-codex-2",
            executor="codex",
            op="run",
            request={"prompt": "检查另一项"},
            origin_ref="conversation:2",
            deadline=180.0,
            routing_class="user_awaited",
            dispatched_at=0.0,
        )
    )
    first = _codex_progress(summary="第一项进度")
    other = _codex_progress(delegate_id="d-codex-2", summary="第二项进度", ts=2.0, seq=3)
    newer = _codex_progress(summary="第一项新进度", ts=3.0, seq=4)

    runtime.apply(first)
    runtime.apply(other)
    runtime.apply(newer)

    first_suggestion, other_suggestion, newer_suggestion = runtime.suggestions.all()
    assert first_suggestion.status == "withdrawn"
    assert other_suggestion.status == "pending"
    assert newer_suggestion.status == "pending"
    assert runtime._latest_progress_suggestion == {  # noqa: SLF001
        "d-codex": newer_suggestion.id,
        "d-codex-2": other_suggestion.id,
    }


@pytest.mark.parametrize("terminal", ("handoff", "deadline"))
def test_terminal_events_withdraw_unselected_codex_progress(terminal: str) -> None:
    runtime = _codex_runtime()
    runtime.apply(_codex_progress())
    suggestion = runtime.suggestions.all()[-1]

    if terminal == "handoff":
        runtime.apply(
            HandoffEvent(
                channel="codex",
                delegate_id="d-codex",
                origin_ref="conversation:1",
                outcome="ok",
                trust="trusted_system",
                content={"result": "done"},
                ts=2.0,
                seq=3,
            )
        )
    else:
        runtime.apply(Deadline(delegate_id="d-codex", ts=2.0, seq=3))

    assert runtime.suggestions.get(suggestion.id).status == "withdrawn"  # type: ignore[union-attr]
    assert runtime._latest_progress_suggestion == {}  # noqa: SLF001


def test_expired_fired_codex_progress_does_not_rearm_from_later_count_only_memory() -> None:
    runtime = _codex_runtime()
    event = _codex_progress()
    runtime.apply(event)
    suggestion = runtime.suggestions.all()[-1]
    runtime.suggestions.fire(suggestion.id, now=event.ts)
    fired = runtime.suggestions.get(suggestion.id)
    assert fired is not None and fired.status == "fired"
    clock = runtime.clock
    assert isinstance(clock, VirtualClock)
    clock.advance_to(fired.expires_at)

    runtime.apply(_codex_progress(summary=None, ts=fired.expires_at + 1.0, seq=3))

    after = runtime.suggestions.get(suggestion.id)
    assert after is not None and after.status == "fired"
    assert not is_available(after, now=clock.now())


def test_progress_accepts_the_bound_non_run_operation() -> None:
    runtime = _runtime(op="start")
    event = _progress(op="start", phase="working", internal_activity=1, elapsed=2.0)

    runtime.apply(event)

    assert runtime.memory.channels["slow_sim"].items[-1].content["op"] == "start"


def test_progress_rejects_an_operation_that_does_not_match_the_delegate() -> None:
    runtime = _runtime(op="start")
    event = _progress(op="task", phase="working", internal_activity=1, elapsed=2.0)

    runtime.apply(event)

    assert runtime.memory.channels["slow_sim"].items == ()


@pytest.mark.asyncio
async def test_dispatch_context_progress_uses_the_bound_delegate_operation() -> None:
    start = OpSpec(
        name="start",
        description="start work",
        params={"type": "object", "properties": {}},
        readonly=False,
    )
    status = OpSpec(
        name="status",
        description="read work status",
        params={"type": "object", "properties": {}},
        readonly=True,
    )

    class ProgressAdapter:
        manifest = ExecutorManifest(name="slow_sim", ops=(start, status), policy=SLOW_SIM_POLICY)

        async def dispatch(self, op: str, request: dict[str, Any], ctx: DispatchContext) -> Handoff:
            assert op == "start"
            assert ctx.progress is not None
            ctx.progress(ProgressPayload(phase="started", internal_activity=0, elapsed=0.0))
            return Handoff(outcome="ok", trust="trusted_system", content={"result": "done"})

    runtime = Runtime(
        clock=VirtualClock(),
        memory=Memory(policies=(SLOW_SIM_POLICY,)),
        executors={"slow_sim": ProgressAdapter()},
    )
    runtime.apply(UserInput("start", ts=0.0, seq=1))
    result = runtime.dispatch_external(
        DelegateRequest(executor="slow_sim", op="start", request={}, origin_ref="conversation:1"),
        reason=WakeReason(kind="user_input", priority=100, routing_class="user_awaited"),
    )

    assert result.accepted is True
    await runtime.run()

    progress = next(event for event in runtime.applied if isinstance(event, ProgressEvent))
    assert progress.op == "start"


@pytest.mark.asyncio
async def test_slow_sim_task_and_codex_run_coexist_on_separate_channels() -> None:
    slow_task = OpSpec(
        name="task",
        description="remote task",
        params={"type": "object", "properties": {}},
        readonly=False,
    )
    codex_run = OpSpec(
        name="run",
        description="code task",
        params={"type": "object", "properties": {}},
        readonly=False,
    )

    class _Adapter:
        def __init__(self, manifest: ExecutorManifest, *, delay: float) -> None:
            self.manifest = manifest
            self.delay = delay

        async def dispatch(
            self,
            op: str,
            request: dict[str, Any],
            ctx: DispatchContext,
        ) -> Handoff:
            del request
            assert ctx.progress is not None
            ctx.progress(ProgressPayload(phase="started", internal_activity=0, elapsed=0.0))
            if self.delay:
                await ctx.clock.sleep(self.delay)
            return Handoff(
                outcome="ok",
                trust="trusted_system",
                content={"op": op},
            )

    slow_sim = _Adapter(
        ExecutorManifest(name="slow_sim", ops=(slow_task,), policy=SLOW_SIM_POLICY),
        delay=2.0,
    )
    codex = _Adapter(
        ExecutorManifest(name="codex", ops=(codex_run,), policy=CODEX_POLICY),
        delay=0.0,
    )
    clock = VirtualClock()
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=(SLOW_SIM_POLICY, CODEX_POLICY)),
        executors={"slow_sim": slow_sim, "codex": codex},  # type: ignore[dict-item]
        expected_active_executors=frozenset({"slow_sim", "codex"}),
    )
    runtime.apply(UserInput("并行执行", ts=0.0, seq=1))

    slow_dispatch = runtime.dispatch_external(
        DelegateRequest(executor="slow_sim", op="task", request={}, origin_ref="conversation:1"),
        reason=WakeReason(kind="user_input", priority=100, routing_class="user_awaited"),
    )
    codex_dispatch = runtime.dispatch_external(
        DelegateRequest(executor="codex", op="run", request={}, origin_ref="conversation:1"),
        reason=WakeReason(kind="user_input", priority=100, routing_class="user_awaited"),
    )

    assert slow_dispatch.accepted and codex_dispatch.accepted
    assert len(runtime.delegates.snapshot()) == 2
    await runtime.run()

    progress = [event for event in runtime.applied if isinstance(event, ProgressEvent)]
    assert {(event.channel, event.op) for event in progress} == {
        ("slow_sim", "task"),
        ("codex", "run"),
    }


@pytest.mark.parametrize(
    "routing_class, expected_slot", [("user_awaited", "fast"), ("ambient", "fast")]
)
def test_valid_progress_appends_rearms_and_wakes_without_termination(
    routing_class: str, expected_slot: str
) -> None:
    runtime = _runtime(routing_class=routing_class)
    suggestion = runtime.suggestions.add(
        origin="executor",
        kind="notify",
        content={"text": "old"},
        evidence_refs=("slow_sim:1",),
    )
    runtime.suggestions.fire(suggestion.id, now=0.0, cooldown=0.0)
    event = _progress()

    runtime.apply(event)
    targets = wake_targets(event, runtime.memory, ledger=runtime.delegates)

    item = runtime.memory.channels["slow_sim"].items[-1]
    assert item.content == {
        "op": "run",
        "phase": "started",
        "internal_activity": 0,
        "elapsed": 0.0,
    }
    assert item.trust == "trusted_system"
    assert item.outcome is None
    assert item.refs == ("conversation:1",)
    assert runtime.delegates.in_flight_delegate("d-1") is not None
    assert runtime.delegates.terminated_by("d-1") is None
    assert runtime.suggestions.get(suggestion.id).status == "pending"  # type: ignore[union-attr]
    assert targets[0][0] == expected_slot
    assert targets[0][1].routing_class == routing_class
    assert targets[0][1].origin == "d-1"


@pytest.mark.parametrize(
    "overrides",
    [
        {"phase": "other"},
        {"internal_activity": True},
        {"phase": "started", "internal_activity": 1},
        {"phase": "working", "internal_activity": 0},
        {"phase": "working", "internal_activity": 1_048_577},
        {"elapsed": True},
        {"elapsed": -0.1},
        {"elapsed": math.nan},
        {"elapsed": math.inf},
        {"channel": "foreign"},
        {"op": "status"},
        {"delegate_id": "d-foreign"},
        {"phase": "working", "internal_activity": 1, "summary": ""},
        {"phase": "working", "internal_activity": 1, "summary": "x" * 401},
        {"phase": "working", "internal_activity": 1, "summary": 123},
        {"phase": "working", "internal_activity": 1, "summary": "控制\x07字符"},
        {"phase": "working", "internal_activity": 1, "summary": "换\n行"},
        {"summary": "started 不携带摘要"},
    ],
)
def test_invalid_stale_or_foreign_progress_is_trace_only(overrides: dict[str, object]) -> None:
    runtime = _runtime()
    suggestion = runtime.suggestions.add(
        origin="executor",
        kind="notify",
        content={"text": "old"},
        evidence_refs=("slow_sim:1",),
    )
    runtime.suggestions.fire(suggestion.id, now=0.0, cooldown=0.0)
    event = _progress(**overrides)

    runtime.apply(event)

    assert runtime.applied == [event]
    assert runtime.memory.channels["slow_sim"].items == ()
    assert wake_targets(event, runtime.memory, ledger=runtime.delegates) == ()
    assert runtime.delegates.in_flight_delegate("d-1") is not None
    assert runtime.suggestions.get(suggestion.id).status == "fired"  # type: ignore[union-attr]


def test_working_progress_summary_is_written_only_when_present() -> None:
    runtime = _runtime()
    event = _progress(phase="working", internal_activity=1, elapsed=2.0, summary="已执行 1 条命令")

    runtime.apply(event)

    item = runtime.memory.channels["slow_sim"].items[-1]
    assert item.content == {
        "op": "run",
        "phase": "working",
        "internal_activity": 1,
        "elapsed": 2.0,
        "summary": "已执行 1 条命令",
    }
    assert item.trust == "trusted_system"


def test_progress_summary_at_the_400_char_boundary_is_accepted() -> None:
    runtime = _runtime()
    event = _progress(phase="working", internal_activity=1, elapsed=2.0, summary="x" * 400)

    runtime.apply(event)

    assert runtime.memory.channels["slow_sim"].items[-1].content["summary"] == "x" * 400


def test_progress_after_termination_has_no_effect() -> None:
    runtime = _runtime()
    terminator = Deadline(delegate_id="d-1", ts=2.0, seq=3)
    runtime.delegates.terminate("d-1", event=terminator)
    event = _progress(phase="working", internal_activity=1, elapsed=2.0)

    runtime.apply(event)

    assert runtime.applied == [event]
    assert runtime.memory.channels["slow_sim"].items == ()
    assert wake_targets(event, runtime.memory, ledger=runtime.delegates) == ()
    assert runtime.delegates.terminated_by("d-1") == "deadline"
