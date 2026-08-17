from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Any, Callable, Mapping

import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.events import WakeReason
from nova_audio_agent.executors.codex import STATUS, CodexProcessStatus, CodexTransportResult, RUN
from nova_audio_agent.executors.codex_app_server import SteerTransportResult
from nova_audio_agent.executors.codex_live import (
    CODEX_LIVE_MANIFEST,
    STEER,
    CodexLiveAdapter,
)
from nova_audio_agent.ports import DelegateRequest, DispatchContext, ProgressPayload, bind_delegate

USER_WAKE = WakeReason(kind="user_input", priority=100, routing_class="user_awaited")


def _ctx(op, request: dict[str, Any], *, progress=None) -> DispatchContext:
    clock = VirtualClock(start=7.0)
    delegate = bind_delegate(
        DelegateRequest(
            executor="codex",
            op=op.name,
            request=request,
            origin_ref="conversation:1",
        ),
        wake_reason=USER_WAKE,
        op=op,
        now=clock.now(),
        delegate_id=f"d-{op.name}",
    )
    return DispatchContext(clock=clock, delegate=delegate, progress=progress)


def _completed() -> CodexTransportResult:
    text = "done"
    return CodexTransportResult(
        classification="completed",
        code="completed",
        content={
            "events": [
                {"type": "thread.started"},
                {"type": "turn.started"},
                {"type": "internal_activity", "count": 1},
                {"type": "turn.completed"},
            ],
            "protocol": {
                "thread_started": True,
                "turn_started": True,
                "terminal": "completed",
                "transport_closed": True,
                "unknown_event_count": 0,
            },
            "process": {"started": True, "exit_code": 0, "stop": "none"},
            "result": {
                "final_message": {
                    "text": text,
                    "original_chars": len(text),
                    "truncated": False,
                    "sha256": hashlib.sha256(text.encode()).hexdigest(),
                }
            },
        },
    )


class _Worker:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.run_calls: list[str] = []
        self.steer_results: list[SteerTransportResult] = []
        self.steer_calls: list[str] = []
        self.preflight_calls = 0
        self.prewarm_calls = 0
        self.aclose_calls = 0
        self.prewarm_gate: asyncio.Event | None = None
        self.prewarm_failure: Exception | None = None
        self.run_failure: Exception | None = None
        self.progress_payloads: list[ProgressPayload] = [
            ProgressPayload(phase="started", internal_activity=0, elapsed=0.0)
        ]

    async def prewarm(self, *, deadline=None) -> Mapping[str, Any] | None:
        self.prewarm_calls += 1
        if self.prewarm_gate is not None:
            await self.prewarm_gate.wait()
        if self.prewarm_failure is not None:
            raise self.prewarm_failure
        return await self._report()

    async def aclose(self) -> None:
        self.aclose_calls += 1

    async def preflight(self, *, deadline=None) -> Mapping[str, Any]:
        self.preflight_calls += 1
        return await self._report()

    async def _report(self) -> Mapping[str, Any]:
        return {
            "version": "0.145.0",
            "root_matches": True,
            "mount": "workspace_only",
            "subprocess": "contained",
            "network": "blocked",
            "credential": {"present": True, "identity": "chatgpt", "policy": "saved_login"},
            "limits": {"cpu": "finite", "as": "finite", "nofile": "finite"},
        }

    async def run(
        self,
        work_order: str,
        *,
        on_status: Callable[[CodexProcessStatus], None],
        on_progress: Callable[[ProgressPayload], None] | None,
        deadline=None,
    ) -> CodexTransportResult:
        self.run_calls.append(work_order)
        on_status(CodexProcessStatus(running=True, exited=False))
        if on_progress is not None:
            for payload in self.progress_payloads:
                on_progress(payload)
        if self.run_failure is not None:
            self.started.set()
            raise self.run_failure
        self.started.set()
        await self.release.wait()
        on_status(
            CodexProcessStatus(
                running=False,
                exited=True,
                terminal="completed",
                exit_code=0,
            )
        )
        return _completed()

    async def steer(self, instruction: str) -> SteerTransportResult:
        self.steer_calls.append(instruction)
        if self.steer_results:
            return self.steer_results.pop(0)
        return SteerTransportResult(code="accepted", written=True)


def test_live_manifest_adds_only_sensitive_strict_steer() -> None:
    assert [op.name for op in CODEX_LIVE_MANIFEST.ops] == ["run", "steer", "status"]
    assert RUN.params["required"] == ["work_order"]
    assert RUN.params["additionalProperties"] is False
    assert STEER.sensitive_params == ("instruction",)
    assert STEER.params["additionalProperties"] is False
    assert STEER.params["properties"]["instruction"] == {
        "type": "string",
        "minLength": 1,
        "maxLength": 2000,
    }


async def test_run_forwards_progress_and_steer_acceptance_without_identity_leak() -> None:
    worker = _Worker()
    adapter = CodexLiveAdapter(worker)
    progress: list[ProgressPayload] = []
    run = asyncio.create_task(
        adapter.dispatch(
            "run", {"work_order": "private work"}, _ctx(RUN, {}, progress=progress.append)
        )
    )
    await worker.started.wait()

    steer = await adapter.dispatch("steer", {"instruction": "private constraint"}, _ctx(STEER, {}))
    worker.release.set()
    handoff = await run

    assert (steer.outcome, steer.trust, steer.content) == (
        "ok",
        "trusted_system",
        {"op": "steer", "worker": "codex", "code": "accepted"},
    )
    assert handoff.outcome == "ok"
    assert handoff.trust == "untrusted_external"
    assert handoff.content["result"]["final_message"]["text"] == "done"
    assert progress == [ProgressPayload(phase="started", internal_activity=0, elapsed=0.0)]
    public = json.dumps(
        {
            "steer": steer.content,
            "run": handoff.content,
            "status": adapter.status.__dict__
            if hasattr(adapter.status, "__dict__")
            else str(adapter.status),
        }
    )
    assert "private constraint" not in public
    assert "thread" not in steer.content
    assert "turn" not in steer.content


@pytest.mark.parametrize(
    "result, outcome, code",
    [
        (SteerTransportResult(code="no_active_turn", written=False), "failed", "no_active_turn"),
        (SteerTransportResult(code="stale_turn", written=False), "failed", "stale_turn"),
        (SteerTransportResult(code="server_rejected", written=True), "failed", "server_rejected"),
        (SteerTransportResult(code="transport_lost", written=True), "unknown", "transport_lost"),
    ],
)
async def test_steer_classification_is_bounded(
    result: SteerTransportResult, outcome: str, code: str
) -> None:
    worker = _Worker()
    worker.steer_results.append(result)
    handoff = await CodexLiveAdapter(worker).dispatch(
        "steer", {"instruction": "secret"}, _ctx(STEER, {})
    )

    assert (handoff.outcome, handoff.trust, handoff.content) == (
        outcome,
        "trusted_system",
        {"op": "steer", "worker": "codex", "code": code},
    )


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"instruction": ""},
        {"instruction": " "},
        {"instruction": "x" * 2001},
        {"instruction": 1},
        {"instruction": "ok", "extra": True},
    ],
)
async def test_steer_requires_the_exact_nonempty_schema(payload: dict[str, Any]) -> None:
    worker = _Worker()
    handoff = await CodexLiveAdapter(worker).dispatch("steer", payload, _ctx(STEER, {}))

    assert handoff.outcome == "failed"
    assert handoff.content == {"error": "invalid_params", "op": "steer"}
    assert worker.steer_calls == []


async def test_running_status_carries_the_latest_progress_summary() -> None:
    """#54: codex.status answers "现在做到哪了" with the last forwarded progress
    prose and step count, not just process liveness; an idle status carries no
    stale progress from the previous run."""
    worker = _Worker()
    worker.progress_payloads.append(
        ProgressPayload(
            phase="working",
            internal_activity=3,
            elapsed=2.0,
            summary="已实现旋转与消行，正在写测试。",
        )
    )
    adapter = CodexLiveAdapter(worker)
    run = asyncio.create_task(
        adapter.dispatch("run", {"work_order": "写俄罗斯方块"}, _ctx(RUN, {}))
    )
    await worker.started.wait()

    running = await adapter.dispatch("status", {}, _ctx(STATUS, {}))
    worker.release.set()
    await run

    assert running.content["state"] == "running"
    assert running.content["progress"] == {
        "internal_activity": 3,
        "summary": "已实现旋转与消行，正在写测试。",
    }

    settled = await adapter.dispatch("status", {}, _ctx(STATUS, {}))
    assert settled.content["state"] != "running"
    assert "progress" not in settled.content


async def test_failed_run_never_advertises_stale_progress() -> None:
    """#54 review: a run that raised while its last process snapshot still said
    running must not keep serving the dead run's progress from status."""
    worker = _Worker()
    worker.progress_payloads.append(
        ProgressPayload(
            phase="working",
            internal_activity=2,
            elapsed=1.0,
            summary="正在实现旋转。",
        )
    )
    worker.run_failure = RuntimeError("transport lost")
    adapter = CodexLiveAdapter(worker)
    handoff = await adapter.dispatch("run", {"work_order": "写俄罗斯方块"}, _ctx(RUN, {}))
    assert handoff.outcome in {"failed", "unknown"}

    status = await adapter.dispatch("status", {}, _ctx(STATUS, {}))
    assert "progress" not in status.content


async def test_active_run_is_busy_not_queued() -> None:
    worker = _Worker()
    adapter = CodexLiveAdapter(worker)
    first = asyncio.create_task(adapter.dispatch("run", {"work_order": "one"}, _ctx(RUN, {})))
    await worker.started.wait()

    second = await adapter.dispatch("run", {"work_order": "two"}, _ctx(RUN, {}))
    worker.release.set()
    await first

    assert second.outcome == "failed"
    assert second.content == {"error": "busy", "op": "run"}
    assert worker.run_calls == ["one"]


async def test_preflight_failure_status_uses_the_current_clock() -> None:
    class _FailingWorker(_Worker):
        async def preflight(self, *, deadline=None):
            deadline.clock.advance_to(11.0)
            raise RuntimeError("private failure")

    adapter = CodexLiveAdapter(_FailingWorker())

    handoff = await adapter.dispatch("run", {"work_order": "work"}, _ctx(RUN, {}))

    assert handoff.outcome == "failed"
    assert adapter.status.finished_at == 11.0
    assert adapter.status.elapsed == 4.0


async def test_preflight_exception_code_requires_the_trusted_allowlist() -> None:
    class _CodedFailure(RuntimeError):
        def __init__(self, code: str) -> None:
            self.code = code
            super().__init__("private failure")

    class _FailingWorker(_Worker):
        def __init__(self, code: str) -> None:
            super().__init__()
            self.code = code

        async def preflight(self, *, deadline=None):
            raise _CodedFailure(self.code)

    for code, expected in (
        ("unsupported_protocol", "unsupported_protocol"),
        ("échec", "transport_failure"),
    ):
        handoff = await CodexLiveAdapter(_FailingWorker(code)).dispatch(
            "run", {"work_order": "work"}, _ctx(RUN, {})
        )

        assert (handoff.outcome, handoff.trust, handoff.content["code"]) == (
            "failed",
            "trusted_system",
            expected,
        )


async def test_prewarm_ready_run_skips_per_run_preflight() -> None:
    """A warm session must not pay the preflight subprocesses again on dispatch."""
    worker = _Worker()
    adapter = CodexLiveAdapter(worker)
    assert adapter.status.prewarm == "cold"

    await adapter.prewarm()

    assert adapter.status.prewarm == "ready"
    assert worker.prewarm_calls == 1
    run = asyncio.create_task(adapter.dispatch("run", {"work_order": "warm work"}, _ctx(RUN, {})))
    await worker.started.wait()
    worker.release.set()
    handoff = await run
    assert handoff.outcome == "ok"
    assert worker.preflight_calls == 0
    assert handoff.content["preflight"]


async def test_prewarm_failure_degrades_to_lazy_preflight_run() -> None:
    """A failed prewarm records failed state and the next run takes the cold path."""
    worker = _Worker()
    worker.prewarm_failure = RuntimeError("spawn failed")
    adapter = CodexLiveAdapter(worker)

    await adapter.prewarm()

    assert adapter.status.prewarm == "failed"
    run = asyncio.create_task(adapter.dispatch("run", {"work_order": "cold work"}, _ctx(RUN, {})))
    await worker.started.wait()
    worker.release.set()
    handoff = await run
    assert handoff.outcome == "ok"
    assert worker.preflight_calls == 1


async def test_closed_transport_resets_ready_prewarm_status_to_cold() -> None:
    """A completed cold/recycled run must not advertise a warm child that no longer exists."""
    worker = _Worker()
    adapter = CodexLiveAdapter(worker)
    await adapter.prewarm()
    assert adapter.status.prewarm == "ready"

    run = asyncio.create_task(
        adapter.dispatch("run", {"work_order": "recycled work"}, _ctx(RUN, {}))
    )
    await worker.started.wait()
    worker.release.set()
    handoff = await run

    assert handoff.outcome == "ok"
    assert adapter.status.prewarm == "cold"
    status = await adapter.dispatch("status", {}, _ctx(STATUS, {}))
    assert status.content["prewarm"] == {"state": "cold"}


async def test_first_run_awaits_inflight_prewarm_instead_of_cold_start() -> None:
    """Dispatch during warmup must join the in-flight prewarm, not race a cold spawn."""
    worker = _Worker()
    worker.prewarm_gate = asyncio.Event()
    adapter = CodexLiveAdapter(worker)
    warmup = asyncio.create_task(adapter.prewarm())
    for _ in range(3):
        await asyncio.sleep(0)
    assert adapter.status.prewarm == "warming"

    run = asyncio.create_task(adapter.dispatch("run", {"work_order": "queued"}, _ctx(RUN, {})))
    for _ in range(3):
        await asyncio.sleep(0)
    assert worker.run_calls == []

    worker.prewarm_gate.set()
    await warmup
    await worker.started.wait()
    worker.release.set()
    handoff = await run
    assert handoff.outcome == "ok"
    assert worker.prewarm_calls == 1
    assert worker.preflight_calls == 0


async def test_status_reports_prewarm_state_and_aclose_reaps_worker() -> None:
    worker = _Worker()
    adapter = CodexLiveAdapter(worker)

    idle = await adapter.dispatch("status", {}, _ctx(STATUS, {}))
    assert idle.content["prewarm"] == {"state": "cold"}

    await adapter.prewarm()
    ready = await adapter.dispatch("status", {}, _ctx(STATUS, {}))
    assert ready.content["prewarm"] == {"state": "ready"}

    await adapter.aclose()
    assert worker.aclose_calls == 1


async def test_open_transport_completion_is_rejected_after_isolated_work_order() -> None:
    """Completed evidence is valid only after the isolated process exits cleanly."""

    class _WarmWorker(_Worker):
        async def run(self, work_order, *, on_status, on_progress, deadline=None):
            self.run_calls.append(work_order)
            on_status(CodexProcessStatus(running=True, exited=False))
            self.started.set()
            await self.release.wait()
            # Contradict the process-per-work-order transport contract.
            on_status(CodexProcessStatus(running=True, exited=False))
            result = _completed()
            content = dict(result.content)
            content["protocol"] = dict(content["protocol"], transport_closed=False)
            content["process"] = dict(content["process"], exit_code=None)
            return CodexTransportResult(
                classification=result.classification, code=result.code, content=content
            )

    worker = _WarmWorker()
    adapter = CodexLiveAdapter(worker)
    run = asyncio.create_task(adapter.dispatch("run", {"work_order": "warm"}, _ctx(RUN, {})))
    await worker.started.wait()
    worker.release.set()

    handoff = await run

    assert handoff.outcome == "unknown"
    assert handoff.content["code"] == "invalid_worker_result"
    assert adapter.status.prewarm == "cold"
