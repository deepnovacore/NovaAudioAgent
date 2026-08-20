from __future__ import annotations

import asyncio
import hashlib
from dataclasses import FrozenInstanceError
from typing import Any, Callable, Iterator, Mapping

import pytest

import nova_audio_agent.executors.codex as codex_module
from nova_audio_agent.clock import RealClock, VirtualClock
from nova_audio_agent.events import WakeReason
from nova_audio_agent.executors.codex import (
    CODEX_MANIFEST,
    CODEX_POLICY,
    RUN,
    STATUS,
    CodexAdapter,
    CodexProcessStatus,
    CodexRunDeadline,
    CodexTransportResult,
)
from nova_audio_agent.memory import HandoffPolicy
from nova_audio_agent.ports import DelegateRequest, DispatchContext, bind_delegate


USER_WAKE = WakeReason(kind="user_input", priority=100, routing_class="user_awaited")
WORK_ORDER = "create the bounded sentinel file"
ITEM_SENTINEL = "INTERNAL-ITEM-PAYLOAD"
TOKEN_SENTINEL = "not-a-real-token-sentinel"
EXCEPTION_SENTINEL = "raw exception sentinel"
_DEFAULT_RESULT = object()


def _ctx(*, now: float = 7.0) -> DispatchContext:
    clock = VirtualClock(start=now)
    delegate = bind_delegate(
        DelegateRequest(
            executor="codex",
            op="run",
            request={"work_order": WORK_ORDER},
            origin_ref="conversation:1",
        ),
        wake_reason=USER_WAKE,
        op=RUN,
        now=clock.now(),
        delegate_id="d-codex-1",
    )
    return DispatchContext(clock=clock, delegate=delegate)


class _FakeWorker:
    def __init__(
        self,
        result: object = _DEFAULT_RESULT,
        *,
        wait: bool = False,
        exception: Exception | None = None,
        exception_after_start: bool = False,
        preflight_report: Mapping[str, Any] | None = None,
        emit_start: bool | None = None,
        emit_exit: bool | None = None,
    ) -> None:
        self.result = (
            _result("completed", code="completed") if result is _DEFAULT_RESULT else result
        )
        self.wait = wait
        self.exception = exception
        self.exception_after_start = exception_after_start
        self.preflight_report = (
            {
                "root_matches": True,
                "credential": {"present": True, "identity": "chatgpt"},
            }
            if preflight_report is None
            else preflight_report
        )
        classification = getattr(self.result, "classification", None)
        self.emit_start = (
            classification != "refused"
            if emit_start is None and isinstance(self.result, CodexTransportResult)
            else bool(emit_start)
        )
        self.emit_exit = self.emit_start if emit_exit is None else emit_exit
        self.preflight_calls = 0
        self.run_calls: list[str] = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def preflight(
        self,
        *,
        deadline: CodexRunDeadline | None = None,
    ) -> Mapping[str, Any]:
        self.preflight_calls += 1
        if self.exception is not None and not self.exception_after_start:
            raise self.exception
        return self.preflight_report

    async def run(
        self,
        work_order: str,
        *,
        on_status: Callable[[CodexProcessStatus], None],
        deadline: CodexRunDeadline | None = None,
    ) -> CodexTransportResult:
        self.run_calls.append(work_order)
        if self.emit_start:
            on_status(CodexProcessStatus(running=True, exited=False))
            self.started.set()
        if self.exception is not None and self.exception_after_start:
            raise self.exception
        if self.wait:
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                if self.emit_start:
                    on_status(
                        CodexProcessStatus(
                            running=False,
                            exited=True,
                            terminal="failed",
                            exit_code=-15,
                        )
                    )
                raise
        if self.emit_exit:
            classification = getattr(self.result, "classification", None)
            terminal = "completed" if classification == "completed" else "failed"
            on_status(
                CodexProcessStatus(
                    running=False,
                    exited=True,
                    terminal=terminal,
                    exit_code=0 if terminal == "completed" else 1,
                )
            )
        return self.result  # type: ignore[return-value]


class _HostileMapping(Mapping[str, Any]):
    def __getitem__(self, key: str) -> Any:
        raise RuntimeError(f"{EXCEPTION_SENTINEL} {TOKEN_SENTINEL}")

    def __iter__(self) -> Iterator[str]:
        raise RuntimeError(f"{EXCEPTION_SENTINEL} {TOKEN_SENTINEL}")

    def __len__(self) -> int:
        raise RuntimeError(f"{EXCEPTION_SENTINEL} {TOKEN_SENTINEL}")


class _CodedPreflightFailure(RuntimeError):
    code = "credential_missing"


class _ExplodingStr(str):
    def __len__(self) -> int:
        raise RuntimeError(f"{EXCEPTION_SENTINEL} {TOKEN_SENTINEL}")


class _ExplodingWorkOrder(str):
    def strip(self, chars: str | None = None) -> str:
        raise RuntimeError(f"{EXCEPTION_SENTINEL} {TOKEN_SENTINEL}")


class _LeakyReprStr(str):
    def __repr__(self) -> str:
        return f"<{EXCEPTION_SENTINEL}:{TOKEN_SENTINEL}>"


def _result(
    classification: str,
    *,
    code: str,
    final_text: str = "done",
) -> CodexTransportResult:
    if classification == "refused":
        content: dict[str, Any] = {}
    else:
        terminal = "completed" if classification == "completed" else "failed"
        exit_code = 0 if terminal == "completed" else 1
        content = {
            "events": [
                {"type": "thread.started"},
                {"type": "turn.started"},
                {"type": "internal_activity", "count": 1},
                {"type": f"turn.{terminal}"},
            ],
            "protocol": {
                "thread_started": True,
                "turn_started": True,
                "terminal": terminal,
                "transport_closed": True,
                "unknown_event_count": 0,
            },
            "process": {"started": True, "exit_code": exit_code, "stop": "none"},
            "result": {
                "final_message": {
                    "text": final_text,
                    "original_chars": len(final_text),
                    "truncated": False,
                    "sha256": hashlib.sha256(final_text.encode()).hexdigest(),
                }
            },
        }
    return CodexTransportResult(
        classification=classification,  # type: ignore[arg-type]
        code=code,
        content=content,
    )


def _assert_opaque(value: object) -> None:
    rendered = repr(value)
    assert WORK_ORDER not in rendered
    assert ITEM_SENTINEL not in rendered
    assert TOKEN_SENTINEL not in rendered
    assert EXCEPTION_SENTINEL not in rendered


def _run_envelope(code: str, preflight: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "op": "run",
        "worker": "codex",
        "code": code,
        "preflight": preflight,
        "goal_verification": "unverified",
    }


def test_manifest_pins_codex_contract() -> None:
    assert CODEX_MANIFEST.name == "codex"
    assert CODEX_MANIFEST.ops == (RUN, STATUS)
    assert CODEX_MANIFEST.policy is CODEX_POLICY

    assert RUN.name == "run"
    assert RUN.deadline_budget == 600.0
    assert RUN.readonly is False
    assert RUN.params == {
        "type": "object",
        "properties": {
            "work_order": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4000,
            }
        },
        "required": ["work_order"],
        "additionalProperties": False,
    }

    assert STATUS.name == "status"
    assert STATUS.deadline_budget == 5.0
    assert STATUS.readonly is True
    assert STATUS.sync_result is True
    assert STATUS.verifies == ()
    assert STATUS.params == {
        "type": "object",
        "properties": {},
        "additionalProperties": False,
    }
    assert CODEX_POLICY == HandoffPolicy(
        channel="codex",
        priority=50,
        wake="fast",
        typical_latency=180.0,
        compress_watermark=5,
        progress_via_surrogate=True,
    )


def test_status_snapshot_starts_idle_and_is_immutable() -> None:
    adapter = CodexAdapter(_FakeWorker())

    snapshot = adapter.status

    assert snapshot.state == "idle"
    assert snapshot.run_sequence == 0
    assert snapshot.started_at is None
    assert snapshot.finished_at is None
    assert snapshot.elapsed is None
    assert snapshot.process_running is False
    assert snapshot.process_exited is False
    assert snapshot.terminal is None
    assert snapshot.exit_code is None
    assert snapshot.preflight == "not_run"
    with pytest.raises(FrozenInstanceError):
        setattr(snapshot, "state", "running")


@pytest.mark.parametrize(
    ("op", "request_payload", "error"),
    [
        ("missing", {}, "unknown_op"),
        ("run", {}, "invalid_params"),
        ("run", {"work_order": ""}, "invalid_params"),
        ("run", {"work_order": "   "}, "invalid_params"),
        ("run", {"work_order": "x" * 4001}, "invalid_params"),
        ("run", {"work_order": True}, "invalid_params"),
        ("run", {"work_order": 1}, "invalid_params"),
        ("run", {"work_order": "ok", "extra": "no"}, "invalid_params"),
        ("status", {"work_order": "no"}, "invalid_params"),
    ],
)
async def test_invalid_request_is_typed_and_never_reaches_worker(
    op: str,
    request_payload: dict[str, Any],
    error: str,
) -> None:
    worker = _FakeWorker()

    handoff = await CodexAdapter(worker).dispatch(op, request_payload, _ctx())

    assert handoff.outcome == "failed"
    assert handoff.trust == "trusted_system"
    assert handoff.content == {"error": error, "op": op}
    assert worker.preflight_calls == 0
    assert worker.run_calls == []
    _assert_opaque(handoff)


async def test_run_normalizes_work_order_before_calling_worker() -> None:
    worker = _FakeWorker()

    handoff = await CodexAdapter(worker).dispatch(
        "run",
        {"work_order": f"  {WORK_ORDER}  "},
        _ctx(),
    )

    assert handoff.outcome == "ok"
    assert worker.run_calls == [WORK_ORDER]
    _assert_opaque(handoff)


async def test_string_subclass_work_order_is_rejected_without_running_code() -> None:
    worker = _FakeWorker()

    handoff = await CodexAdapter(worker).dispatch(
        "run",
        {"work_order": _ExplodingWorkOrder(WORK_ORDER)},
        _ctx(),
    )

    assert handoff.content == {"error": "invalid_params", "op": "run"}
    assert worker.preflight_calls == 0
    assert worker.run_calls == []
    _assert_opaque(handoff)


async def test_status_tracks_running_and_exited_without_exposing_worker_content() -> None:
    worker = _FakeWorker(wait=True)
    adapter = CodexAdapter(worker)
    original = adapter.status

    run_task = asyncio.create_task(
        adapter.dispatch("run", {"work_order": WORK_ORDER}, _ctx(now=11.0))
    )
    await worker.started.wait()

    running = adapter.status
    status_handoff = await adapter.dispatch("status", {}, _ctx(now=12.0))

    assert original.state == "idle"
    assert running.state == "running"
    assert running.run_sequence == 1
    assert running.started_at == 11.0
    assert running.finished_at is None
    assert running.process_running is True
    assert running.process_exited is False
    assert running.preflight == "passed"
    assert status_handoff.outcome == "ok"
    assert status_handoff.trust == "trusted_system"
    assert status_handoff.content == {
        "op": "status",
        "state": "running",
        "run_sequence": 1,
        "started_at": 11.0,
        "finished_at": None,
        "elapsed": 1.0,
        "process": {
            "running": True,
            "exited": False,
            "exit_code": None,
        },
        "protocol": {"terminal": None},
        "preflight": {"verdict": "passed"},
    }
    _assert_opaque(running)
    _assert_opaque(status_handoff)

    worker.release.set()
    handoff = await run_task
    exited = adapter.status

    assert handoff.outcome == "ok"
    assert exited.state == "exited"
    assert exited.run_sequence == 1
    assert exited.started_at == 11.0
    assert exited.finished_at == 11.0
    assert exited.elapsed == 0.0
    assert exited.process_running is False
    assert exited.process_exited is True
    assert exited.terminal == "completed"
    assert exited.exit_code == 0
    assert exited.preflight == "passed"
    _assert_opaque(exited)
    _assert_opaque(handoff)


async def test_second_concurrent_run_returns_busy_without_reaching_worker() -> None:
    worker = _FakeWorker(wait=True)
    adapter = CodexAdapter(worker)
    first = asyncio.create_task(adapter.dispatch("run", {"work_order": WORK_ORDER}, _ctx()))
    await worker.started.wait()

    second = await adapter.dispatch("run", {"work_order": "second"}, _ctx())

    assert second.outcome == "failed"
    assert second.trust == "trusted_system"
    assert second.content == {"error": "busy", "op": "run"}
    assert worker.preflight_calls == 1
    assert worker.run_calls == [WORK_ORDER]

    worker.release.set()
    await first


@pytest.mark.parametrize(
    ("classification", "code", "expected_code", "outcome", "trust"),
    [
        ("completed", "completed", "completed", "ok", "untrusted_external"),
        ("refused", "preflight_failed", "worker_refused", "failed", "trusted_system"),
        ("uncertain", "turn_failed", "turn_failed", "unknown", "untrusted_external"),
    ],
)
async def test_transport_classification_maps_to_typed_handoff(
    classification: str,
    code: str,
    expected_code: str,
    outcome: str,
    trust: str,
) -> None:
    worker = _FakeWorker(_result(classification, code=code, final_text="safe final"))
    adapter = CodexAdapter(worker)

    handoff = await adapter.dispatch(
        "run",
        {"work_order": WORK_ORDER},
        _ctx(),
    )

    assert handoff.outcome == outcome
    assert handoff.trust == trust
    assert handoff.content["code"] == expected_code
    assert handoff.content["preflight"] == {
        "root_matches": True,
        "credential": {"present": True, "identity": "chatgpt"},
    }
    if classification == "refused":
        assert "events" not in handoff.content
    else:
        assert handoff.content["result"]["final_message"]["text"] == "safe final"
    _assert_opaque(handoff)
    if classification == "refused":
        assert adapter.status.state == "idle"
        assert adapter.status.process_running is False
        assert adapter.status.process_exited is False
        assert adapter.status.finished_at == 7.0


async def test_task3_envelope_never_retains_worker_content() -> None:
    result = _result("completed", code="completed")
    result.content["item_payload"] = ITEM_SENTINEL  # type: ignore[index]
    result.content["credential_value"] = TOKEN_SENTINEL  # type: ignore[index]
    worker = _FakeWorker(
        result,
    )

    handoff = await CodexAdapter(worker).dispatch(
        "run",
        {"work_order": WORK_ORDER},
        _ctx(),
    )

    assert (handoff.outcome, handoff.trust) == ("unknown", "untrusted_external")
    assert handoff.content["code"] == "invalid_worker_result"
    _assert_opaque(handoff)


async def test_handoff_uses_exact_preflight_call_report_not_result_content() -> None:
    preflight = {
        "version": "0.145.0",
        "root_matches": True,
        "mount": "workspace_only",
        "subprocess": "contained",
        "network": "blocked",
        "credential": {
            "present": True,
            "identity": "chatgpt",
            "policy": "saved_login",
        },
        "limits": {"cpu": "finite", "address_space": "unbounded"},
    }
    result = _result("completed", code="completed")
    worker = _FakeWorker(result, preflight_report=preflight)

    handoff = await CodexAdapter(worker).dispatch(
        "run",
        {"work_order": WORK_ORDER},
        _ctx(),
    )

    assert handoff.content["preflight"] == preflight
    _assert_opaque(handoff)


def test_preflight_limit_special_key_is_an_ordinary_python_dict_key() -> None:
    report = codex_module._sanitize_preflight({"limits": {"__proto__": "finite"}})

    assert report == {"limits": {"__proto__": "finite"}}


async def test_hostile_result_content_is_rejected_without_reading_it() -> None:
    result = CodexTransportResult(
        classification="completed",
        code="completed",
        content=_HostileMapping(),
    )

    handoff = await CodexAdapter(_FakeWorker(result)).dispatch(
        "run",
        {"work_order": WORK_ORDER},
        _ctx(),
    )

    assert handoff.outcome == "unknown"
    assert handoff.content["code"] == "invalid_worker_result"
    _assert_opaque(handoff)


async def test_refused_after_process_start_is_unknown_external_evidence() -> None:
    worker = _FakeWorker(
        _result("refused", code="preflight_failed"),
        emit_start=True,
        emit_exit=False,
    )
    adapter = CodexAdapter(worker)

    handoff = await adapter.dispatch(
        "run",
        {"work_order": WORK_ORDER},
        _ctx(),
    )

    assert (handoff.outcome, handoff.trust) == ("unknown", "untrusted_external")
    assert adapter.status.state == "running"
    assert adapter.status.process_running is True
    assert adapter.status.process_exited is False
    _assert_opaque(handoff)


async def test_completed_without_process_exit_evidence_is_unknown() -> None:
    worker = _FakeWorker(
        _result("completed", code="completed"),
        emit_start=True,
        emit_exit=False,
    )
    adapter = CodexAdapter(worker)

    handoff = await adapter.dispatch(
        "run",
        {"work_order": WORK_ORDER},
        _ctx(),
    )

    assert (handoff.outcome, handoff.trust) == ("unknown", "untrusted_external")
    assert handoff.content["code"] == "invalid_worker_result"
    assert adapter.status.state == "running"
    assert adapter.status.process_running is True
    assert adapter.status.process_exited is False
    _assert_opaque(handoff)


async def test_completed_with_failed_process_evidence_is_unknown() -> None:
    class _FailedExitWorker(_FakeWorker):
        async def run(
            self,
            work_order: str,
            *,
            on_status: Callable[[CodexProcessStatus], None],
            deadline: CodexRunDeadline | None = None,
        ) -> CodexTransportResult:
            self.run_calls.append(work_order)
            on_status(CodexProcessStatus(running=True, exited=False))
            on_status(
                CodexProcessStatus(
                    running=False,
                    exited=True,
                    terminal="failed",
                    exit_code=1,
                )
            )
            return _result("completed", code="completed")

    adapter = CodexAdapter(_FailedExitWorker())

    handoff = await adapter.dispatch(
        "run",
        {"work_order": WORK_ORDER},
        _ctx(),
    )

    assert (handoff.outcome, handoff.trust) == ("unknown", "untrusted_external")
    assert handoff.content["code"] == "invalid_worker_result"
    assert adapter.status.terminal == "failed"
    assert adapter.status.exit_code == 1
    _assert_opaque(handoff)


async def test_malformed_string_subclass_cannot_escape_result_boundary() -> None:
    result = CodexTransportResult(
        classification="completed",
        code=_ExplodingStr("completed"),
        content={},
    )
    adapter = CodexAdapter(_FakeWorker(result))

    handoff = await adapter.dispatch(
        "run",
        {"work_order": WORK_ORDER},
        _ctx(),
    )

    assert (handoff.outcome, handoff.trust) == ("unknown", "untrusted_external")
    assert handoff.content["code"] == "invalid_worker_result"
    _assert_opaque(handoff)


async def test_refused_result_code_is_a_fixed_system_owned_enum() -> None:
    adapter = CodexAdapter(_FakeWorker(_result("refused", code="supersecretplainvalue")))

    handoff = await adapter.dispatch(
        "run",
        {"work_order": WORK_ORDER},
        _ctx(),
    )

    assert (handoff.outcome, handoff.trust) == ("failed", "trusted_system")
    assert handoff.content["code"] == "worker_refused"
    assert "supersecretplainvalue" not in repr(handoff)
    _assert_opaque(handoff)


@pytest.mark.parametrize(
    ("result", "emit_start", "outcome", "trust", "state"),
    [
        (None, False, "failed", "trusted_system", "idle"),
        (
            CodexTransportResult(
                classification="invalid",  # type: ignore[arg-type]
                code="invalid",
                content={},
            ),
            True,
            "unknown",
            "untrusted_external",
            "running",
        ),
    ],
)
async def test_malformed_worker_result_is_typed_from_process_evidence(
    result: object,
    emit_start: bool,
    outcome: str,
    trust: str,
    state: str,
) -> None:
    worker = _FakeWorker(result, emit_start=emit_start, emit_exit=False)
    adapter = CodexAdapter(worker)

    handoff = await adapter.dispatch(
        "run",
        {"work_order": WORK_ORDER},
        _ctx(),
    )

    assert (handoff.outcome, handoff.trust) == (outcome, trust)
    assert handoff.content["code"] == "invalid_worker_result"
    assert adapter.status.state == state
    assert adapter.status.process_exited is False
    assert adapter.status.finished_at == (7.0 if state == "idle" else None)
    _assert_opaque(handoff)
    _assert_opaque(adapter.status)


@pytest.mark.parametrize("classification", ["completed", "uncertain"])
async def test_success_or_uncertainty_without_process_start_is_invalid(
    classification: str,
) -> None:
    worker = _FakeWorker(
        _result(classification, code=classification),
        emit_start=False,
        emit_exit=False,
    )
    adapter = CodexAdapter(worker)

    handoff = await adapter.dispatch(
        "run",
        {"work_order": WORK_ORDER},
        _ctx(),
    )

    assert (handoff.outcome, handoff.trust) == ("failed", "trusted_system")
    assert handoff.content["code"] == "invalid_worker_result"
    assert adapter.status.state == "idle"
    assert adapter.status.process_running is False
    assert adapter.status.process_exited is False
    _assert_opaque(handoff)


async def test_hostile_preflight_report_becomes_credential_free_failure() -> None:
    worker = _FakeWorker(preflight_report=_HostileMapping())
    adapter = CodexAdapter(worker)

    handoff = await adapter.dispatch(
        "run",
        {"work_order": WORK_ORDER},
        _ctx(),
    )

    assert (handoff.outcome, handoff.trust) == ("failed", "trusted_system")
    assert handoff.content == _run_envelope("invalid_preflight_report", {})
    assert worker.run_calls == []
    assert adapter.status.state == "idle"
    assert adapter.status.finished_at == 7.0
    assert adapter.status.preflight == "failed"
    _assert_opaque(handoff)


async def test_preflight_drops_unexpected_free_form_content() -> None:
    worker = _FakeWorker(
        preflight_report={
            "root_matches": True,
            "diagnostic": f"{EXCEPTION_SENTINEL} {TOKEN_SENTINEL}",
            "credential": {
                "present": True,
                "identity": "chatgpt",
                "detail": TOKEN_SENTINEL,
            },
        }
    )

    handoff = await CodexAdapter(worker).dispatch(
        "run",
        {"work_order": WORK_ORDER},
        _ctx(),
    )

    assert handoff.content["preflight"] == {
        "root_matches": True,
        "credential": {"present": True, "identity": "chatgpt"},
    }
    _assert_opaque(handoff)


async def test_preflight_string_subclass_cannot_enter_handoff() -> None:
    worker = _FakeWorker(
        preflight_report={
            "version": _LeakyReprStr("0.145.0"),
            "root_matches": True,
        }
    )

    handoff = await CodexAdapter(worker).dispatch(
        "run",
        {"work_order": WORK_ORDER},
        _ctx(),
    )

    assert (handoff.outcome, handoff.trust) == ("failed", "trusted_system")
    assert handoff.content == _run_envelope("invalid_preflight_report", {})
    assert worker.run_calls == []
    _assert_opaque(handoff)


async def test_safe_preflight_failure_code_is_preserved_without_exception_text() -> None:
    worker = _FakeWorker(exception=_CodedPreflightFailure(f"{EXCEPTION_SENTINEL} {TOKEN_SENTINEL}"))
    adapter = CodexAdapter(worker)

    handoff = await adapter.dispatch(
        "run",
        {"work_order": WORK_ORDER},
        _ctx(),
    )

    assert handoff.content == _run_envelope("credential_missing", {})
    assert adapter.status.state == "idle"
    assert adapter.status.finished_at == 7.0
    _assert_opaque(handoff)


@pytest.mark.parametrize("after_start", [False, True])
async def test_worker_exception_becomes_credential_free_handoff(after_start: bool) -> None:
    worker = _FakeWorker(
        exception=RuntimeError(f"{EXCEPTION_SENTINEL} {TOKEN_SENTINEL}"),
        exception_after_start=after_start,
    )
    adapter = CodexAdapter(worker)

    handoff = await adapter.dispatch(
        "run",
        {"work_order": WORK_ORDER},
        _ctx(),
    )

    if after_start:
        assert (handoff.outcome, handoff.trust) == ("unknown", "untrusted_external")
        assert handoff.content["code"] == "worker_exception_after_start"
    else:
        assert (handoff.outcome, handoff.trust) == ("failed", "trusted_system")
        assert handoff.content["code"] == "worker_exception_before_start"
    _assert_opaque(handoff)
    _assert_opaque(adapter.status)
    assert adapter.status.state == ("running" if after_start else "idle")
    assert adapter.status.process_running is after_start
    assert adapter.status.process_exited is False
    assert adapter.status.preflight == ("passed" if after_start else "failed")


async def test_run_uses_one_540_second_deadline_across_both_worker_phases() -> None:
    ctx = _ctx(now=7.0)
    deadlines: list[CodexRunDeadline | None] = []

    class _DeadlineWorker(_FakeWorker):
        async def preflight(
            self,
            *,
            deadline: CodexRunDeadline | None = None,
        ) -> Mapping[str, Any]:
            deadlines.append(deadline)
            ctx.clock.advance_to(27.0)  # type: ignore[attr-defined]
            return self.preflight_report

        async def run(
            self,
            work_order: str,
            *,
            on_status: Callable[[CodexProcessStatus], None],
            deadline: CodexRunDeadline | None = None,
        ) -> CodexTransportResult:
            deadlines.append(deadline)
            on_status(CodexProcessStatus(running=True, exited=False))
            ctx.clock.advance_to(547.0)  # type: ignore[attr-defined]
            return _result("uncertain", code="timeout")

    handoff = await CodexAdapter(_DeadlineWorker()).dispatch(
        "run",
        {"work_order": WORK_ORDER},
        ctx,
    )

    assert deadlines[0] is deadlines[1]
    assert deadlines[0] is not None
    assert deadlines[0].expires_at == 547.0
    assert (handoff.outcome, handoff.trust) == ("unknown", "untrusted_external")
    assert handoff.content["code"] == "adapter_timeout"
    assert handoff.content["preflight"] != {}
    _assert_opaque(handoff)


async def test_aggregate_deadline_expiry_before_process_start_is_failed() -> None:
    ctx = _ctx(now=7.0)
    run_called = False

    class _PreflightExhaustsBudget(_FakeWorker):
        async def preflight(
            self,
            *,
            deadline: CodexRunDeadline | None = None,
        ) -> Mapping[str, Any]:
            assert deadline is not None
            assert deadline.expires_at == 547.0
            ctx.clock.advance_to(547.0)  # type: ignore[attr-defined]
            return self.preflight_report

        async def run(
            self,
            work_order: str,
            *,
            on_status: Callable[[CodexProcessStatus], None],
            deadline: CodexRunDeadline | None = None,
        ) -> CodexTransportResult:
            nonlocal run_called
            run_called = True
            return _result("completed", code="completed")

    handoff = await CodexAdapter(_PreflightExhaustsBudget()).dispatch(
        "run",
        {"work_order": WORK_ORDER},
        ctx,
    )

    assert run_called is False
    assert (handoff.outcome, handoff.trust) == ("failed", "trusted_system")
    assert handoff.content["code"] == "adapter_timeout"
    assert handoff.content["preflight"] == {}
    assert CodexAdapter(_FakeWorker()).manifest.ops[0].deadline_budget == 600.0
    _assert_opaque(handoff)


async def test_real_clock_dispatch_enforces_wall_clock_adapter_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _ControlledRealClock(RealClock):
        def __init__(self) -> None:
            self.current = 100.0

        def now(self) -> float:
            return self.current

    clock = _ControlledRealClock()
    delegate = bind_delegate(
        DelegateRequest(
            executor="codex",
            op="run",
            request={"work_order": WORK_ORDER},
            origin_ref="conversation:1",
        ),
        wake_reason=USER_WAKE,
        op=RUN,
        now=clock.now(),
        delegate_id="d-codex-real-clock",
    )
    observed_timeouts: list[float] = []

    class _ExpiringTimeout:
        async def __aenter__(self) -> None:
            return None

        async def __aexit__(self, *_: object) -> None:
            clock.current += observed_timeouts[-1]
            raise TimeoutError

    def timeout(delay: float) -> _ExpiringTimeout:
        observed_timeouts.append(delay)
        return _ExpiringTimeout()

    monkeypatch.setattr(codex_module.asyncio, "timeout", timeout)

    handoff = await CodexAdapter(_FakeWorker()).dispatch(
        "run",
        {"work_order": WORK_ORDER},
        DispatchContext(clock=clock, delegate=delegate),
    )

    assert observed_timeouts == [pytest.approx(540.0)]
    assert (handoff.outcome, handoff.trust) == ("failed", "trusted_system")
    assert handoff.content["code"] == "adapter_timeout"
    _assert_opaque(handoff)


async def test_cancellation_cleans_adapter_state_and_re_raises() -> None:
    worker = _FakeWorker(wait=True)
    adapter = CodexAdapter(worker)
    task = asyncio.create_task(adapter.dispatch("run", {"work_order": WORK_ORDER}, _ctx()))
    await worker.started.wait()

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert adapter.status.state == "exited"
    assert adapter.status.process_running is False
    assert adapter.status.process_exited is True
    assert adapter.status.terminal == "failed"
    assert adapter.status.exit_code == -15
    worker.wait = False
    next_handoff = await adapter.dispatch("run", {"work_order": "next"}, _ctx())
    assert next_handoff.outcome == "ok"
    assert worker.run_calls == [WORK_ORDER, "next"]
    assert adapter.status.run_sequence == 2


@pytest.mark.parametrize(
    "status",
    (
        CodexProcessStatus(running=1, exited=False),  # type: ignore[arg-type]
        CodexProcessStatus(
            running=False,
            exited=1,  # type: ignore[arg-type]
            terminal="completed",
            exit_code=False,
        ),
    ),
)
async def test_malformed_process_status_never_proves_completion(
    status: CodexProcessStatus,
) -> None:
    class _MalformedStatusWorker(_FakeWorker):
        async def run(
            self,
            work_order: str,
            *,
            on_status: Callable[[CodexProcessStatus], None],
            deadline: CodexRunDeadline | None = None,
        ) -> CodexTransportResult:
            self.run_calls.append(work_order)
            if status.exited:
                on_status(CodexProcessStatus(running=True, exited=False))
            on_status(status)
            return _result("completed", code="completed")

    adapter = CodexAdapter(_MalformedStatusWorker())

    handoff = await adapter.dispatch(
        "run",
        {"work_order": WORK_ORDER},
        _ctx(),
    )

    assert handoff.outcome in {"failed", "unknown"}
    assert handoff.outcome != "ok"
    assert "completed" not in repr(handoff)
    _assert_opaque(handoff)
