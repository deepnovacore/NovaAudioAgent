"""Opt-in Codex live adapter with same-turn steering."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from dataclasses import replace
from typing import Any, Protocol

from nova_audio_agent.executors.codex import (
    ADAPTER_TIMEOUT,
    CODEX_POLICY,
    RUN,
    STATUS,
    CodexProcessStatus,
    CodexRunDeadline,
    CodexStatusSnapshot,
    CodexTransportResult,
    _exception_code,
    _failure,
    _normalize_run_request,
    _run_handoff,
    _safe_code,
    _sanitize_preflight,
    _sanitize_transport_content,
    _validate_process_status,
)
from nova_audio_agent.executors.codex_app_server import SteerTransportResult
from nova_audio_agent.ports import (
    DispatchContext,
    ExecutorManifest,
    Handoff,
    OpSpec,
    ProgressPayload,
)

STEER = OpSpec(
    name="steer",
    description="向当前仍在执行的 Codex turn 追加约束；不终止、不重启、不创建下一轮。",
    params={
        "type": "object",
        "properties": {
            "instruction": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000,
            }
        },
        "required": ["instruction"],
        "additionalProperties": False,
    },
    readonly=False,
    deadline_budget=30.0,
    sensitive_params=("instruction",),
)

CODEX_LIVE_MANIFEST = ExecutorManifest(
    name="codex",
    ops=(RUN, STEER, STATUS),
    policy=CODEX_POLICY,
)


class CodexLiveWorker(Protocol):
    async def prewarm(
        self,
        *,
        deadline: CodexRunDeadline | None = None,
    ) -> Mapping[str, Any] | None: ...

    async def aclose(self) -> None: ...

    async def preflight(
        self,
        *,
        deadline: CodexRunDeadline | None = None,
    ) -> Mapping[str, Any]: ...

    async def run(
        self,
        work_order: str,
        *,
        on_status: Callable[[CodexProcessStatus], None],
        on_progress: Callable[[ProgressPayload], None] | None,
        deadline: CodexRunDeadline | None = None,
    ) -> CodexTransportResult: ...

    async def steer(self, instruction: str) -> SteerTransportResult: ...


class CodexLiveAdapter:
    manifest = CODEX_LIVE_MANIFEST

    def __init__(self, worker: CodexLiveWorker) -> None:
        self._worker = worker
        self._run_lock = asyncio.Lock()
        self._status = CodexStatusSnapshot()
        self._prewarm_inflight: asyncio.Task[None] | None = None
        self._prewarm_report: dict[str, Any] | None = None
        # #54: the last forwarded progress payload, so a status query can answer
        # "现在做到哪了" with prose instead of bare process liveness.
        self._last_progress: ProgressPayload | None = None

    async def prewarm(self, *, deadline: CodexRunDeadline | None = None) -> None:
        """Warm the app-server session ahead of the first delegation (R101).

        Never raises: a failed warmup records ``prewarm="failed"`` and the next
        run degrades to the lazy cold path.
        """
        if self._prewarm_inflight is None or self._prewarm_inflight.done():
            self._prewarm_inflight = asyncio.get_running_loop().create_task(
                self._do_prewarm(deadline)
            )
        await self._prewarm_inflight

    async def aclose(self) -> None:
        """Session-level teardown: stop warmup, reap the worker process."""
        inflight = self._prewarm_inflight
        if inflight is not None and not inflight.done():
            inflight.cancel()
            await asyncio.gather(inflight, return_exceptions=True)
        self._prewarm_inflight = None
        self._prewarm_report = None
        await self._worker.aclose()
        self._status = replace(self._status, prewarm="cold")

    async def _do_prewarm(self, deadline: CodexRunDeadline | None) -> None:
        self._status = replace(self._status, prewarm="warming")
        try:
            report = await self._worker.prewarm(deadline=deadline)
            if report is not None:
                self._prewarm_report = _sanitize_preflight(report)
            elif self._prewarm_report is None:
                self._prewarm_report = {}
        except (asyncio.CancelledError, KeyboardInterrupt, SystemExit):
            self._status = replace(self._status, prewarm="failed")
            raise
        except Exception:
            self._status = replace(self._status, prewarm="failed")
            return
        self._status = replace(self._status, prewarm="ready")

    @property
    def status(self) -> CodexStatusSnapshot:
        return self._status

    async def dispatch(
        self,
        op: str,
        request: dict[str, Any],
        ctx: DispatchContext,
    ) -> Handoff:
        if op == "status":
            if request:
                return _failure("invalid_params", op)
            return Handoff(
                outcome="ok",
                trust="trusted_system",
                content=self._status_content(ctx.clock.now()),
            )
        if op == "steer":
            instruction = _normalize_steer_request(request)
            if instruction is None:
                return _failure("invalid_params", op)
            return await self._steer(instruction)
        if op != "run":
            return _failure("unknown_op", op)
        work_order = _normalize_run_request(request)
        if work_order is None:
            return _failure("invalid_params", op)
        if self._run_lock.locked():
            return _failure("busy", op)
        await self._run_lock.acquire()
        try:
            return await self._run(work_order, ctx)
        finally:
            self._run_lock.release()

    async def _run(self, work_order: str, ctx: DispatchContext) -> Handoff:
        started_at = ctx.clock.now()
        sequence = self._status.run_sequence + 1
        deadline = CodexRunDeadline(expires_at=started_at + ADAPTER_TIMEOUT, clock=ctx.clock)
        process_started = False
        preflight_passed = False
        preflight: dict[str, Any] = {}
        self._last_progress = None
        self._status = CodexStatusSnapshot(
            state="running",
            run_sequence=sequence,
            started_at=started_at,
            elapsed=0.0,
            prewarm=self._status.prewarm,
        )

        def on_status(value: CodexProcessStatus) -> None:
            nonlocal process_started
            process = _validate_process_status(value)
            process_started = process_started or process.running or process.exited
            now = ctx.clock.now()
            self._status = CodexStatusSnapshot(
                state="exited" if process.exited else "running",
                run_sequence=sequence,
                started_at=started_at,
                finished_at=now if process.exited else None,
                elapsed=max(0.0, now - started_at),
                process_running=process.running,
                process_exited=process.exited,
                terminal=process.terminal,
                exit_code=process.exit_code,
                preflight="passed",
                prewarm=self._status.prewarm,
            )

        try:
            inflight = self._prewarm_inflight
            if inflight is not None and not inflight.done():
                # Join the in-flight warmup instead of racing it with a cold spawn.
                await inflight
            if self._status.prewarm == "ready" and self._prewarm_report is not None:
                preflight = self._prewarm_report
                preflight_passed = True
            else:
                preflight = _sanitize_preflight(await self._worker.preflight(deadline=deadline))
                preflight_passed = True
            result = await self._worker.run(
                work_order,
                on_status=on_status,
                on_progress=self._retain_progress(ctx.progress),
                deadline=deadline,
            )
        except asyncio.CancelledError:
            self._mark_prewarm_cold()
            self._settle(
                started_at,
                finished_at=ctx.clock.now(),
                preflight_passed=preflight_passed,
            )
            raise
        except Exception as failure:
            self._mark_prewarm_cold()
            self._settle(
                started_at,
                finished_at=ctx.clock.now(),
                preflight_passed=preflight_passed,
            )
            code = _exception_code(failure, fallback="transport_failure")
            return _run_handoff(
                outcome="unknown" if process_started else "failed",
                trust="untrusted_external" if process_started else "trusted_system",
                code=code,
                preflight=preflight,
            )

        self._settle(
            started_at,
            finished_at=ctx.clock.now(),
            preflight_passed=True,
        )
        if type(result) is not CodexTransportResult:
            self._mark_prewarm_cold()
            return _run_handoff(
                outcome="unknown" if process_started else "failed",
                trust="untrusted_external" if process_started else "trusted_system",
                code="invalid_worker_result",
                preflight=preflight,
            )
        if result.classification == "refused":
            self._mark_prewarm_cold()
            return _run_handoff(
                outcome="failed",
                trust="trusted_system",
                code=_safe_code(result.code),
                preflight=preflight,
            )
        evidence = _sanitize_transport_content(result.content)
        if evidence is None:
            self._mark_prewarm_cold()
            return _run_handoff(
                outcome="unknown",
                trust="untrusted_external",
                code="invalid_worker_result",
                preflight=preflight,
            )
        if result.classification == "completed":
            cold_clean = (
                self._status.process_exited
                and self._status.terminal == "completed"
                and self._status.exit_code == 0
            )
            clean = result.code == "completed" and cold_clean
            self._mark_prewarm_cold()
            return _run_handoff(
                outcome="ok" if clean else "unknown",
                trust="untrusted_external",
                code="completed" if clean else "invalid_worker_result",
                preflight=preflight,
                evidence=evidence,
            )
        if result.classification == "uncertain":
            self._mark_prewarm_cold()
            return _run_handoff(
                outcome="unknown",
                trust="untrusted_external",
                code=_safe_code(result.code),
                preflight=preflight,
                evidence=evidence,
            )
        self._mark_prewarm_cold()
        return _run_handoff(
            outcome="unknown",
            trust="untrusted_external",
            code="invalid_worker_result",
            preflight=preflight,
        )

    def _mark_prewarm_cold(self) -> None:
        self._prewarm_report = None
        self._status = replace(self._status, prewarm="cold")

    async def _steer(self, instruction: str) -> Handoff:
        try:
            result = await self._worker.steer(instruction)
        except Exception:
            result = SteerTransportResult(code="transport_lost", written=True)
        if type(result) is not SteerTransportResult:
            result = SteerTransportResult(code="transport_lost", written=True)
        outcome = (
            "ok"
            if result.code == "accepted"
            else "unknown"
            if result.code == "transport_lost"
            else "failed"
        )
        return Handoff(
            outcome=outcome,
            trust="trusted_system",
            content={"op": "steer", "worker": "codex", "code": result.code},
        )

    def _settle(
        self,
        started_at: float,
        *,
        finished_at: float,
        preflight_passed: bool,
    ) -> None:
        # #54: the run is over from the adapter's perspective even when the
        # last process snapshot still said running (cancellation kills the
        # process after the final status callback) — a settled run must not
        # keep serving its progress from status.
        self._last_progress = None
        now = max(started_at, self._status.finished_at or finished_at)
        if self._status.process_exited:
            self._status = replace(
                self._status,
                state="exited",
                elapsed=max(0.0, now - started_at),
                preflight="passed" if preflight_passed else "failed",
            )
        elif self._status.process_running:
            self._status = replace(
                self._status,
                state="running",
                elapsed=max(0.0, now - started_at),
                preflight="passed" if preflight_passed else "failed",
            )
        else:
            self._status = replace(
                self._status,
                state="idle",
                finished_at=now,
                elapsed=max(0.0, now - started_at),
                preflight="passed" if preflight_passed else "failed",
            )

    def _retain_progress(
        self,
        forward: Callable[[ProgressPayload], None] | None,
    ) -> Callable[[ProgressPayload], None]:
        def observe(payload: ProgressPayload) -> None:
            self._last_progress = payload
            if forward is not None:
                forward(payload)

        return observe

    def _status_content(self, now: float) -> dict[str, Any]:
        snapshot = self._status
        elapsed = snapshot.elapsed
        if snapshot.state == "running" and snapshot.started_at is not None:
            elapsed = max(0.0, now - snapshot.started_at)
        content: dict[str, Any] = {
            "op": "status",
            "state": snapshot.state,
            "run_sequence": snapshot.run_sequence,
            "started_at": snapshot.started_at,
            "finished_at": snapshot.finished_at,
            "elapsed": elapsed,
            "process": {
                "running": snapshot.process_running,
                "exited": snapshot.process_exited,
                "exit_code": snapshot.exit_code,
            },
            "protocol": {"terminal": snapshot.terminal},
            "preflight": {"verdict": snapshot.preflight},
            "prewarm": {"state": snapshot.prewarm},
        }
        if snapshot.state == "running" and self._last_progress is not None:
            progress: dict[str, Any] = {"internal_activity": self._last_progress.internal_activity}
            if self._last_progress.summary is not None:
                progress["summary"] = self._last_progress.summary
            content["progress"] = progress
        return content


def _normalize_steer_request(request: Mapping[str, Any]) -> str | None:
    if set(request) != {"instruction"}:
        return None
    instruction = request.get("instruction")
    if type(instruction) is not str:
        return None
    instruction = instruction.strip()
    if not instruction or len(instruction) > 2000:
        return None
    return instruction
