"""Codex opaque-worker executor contract."""

from __future__ import annotations

import asyncio
import hashlib
import re
import unicodedata
from dataclasses import dataclass, replace
from typing import Any, Awaitable, Callable, Literal, Mapping, Protocol

from nova_audio_agent.clock import Clock, RealClock
from nova_audio_agent.memory import HandoffPolicy
from nova_audio_agent.ports import DispatchContext, ExecutorManifest, Handoff, OpSpec

_CODEX_VERSION = re.compile(r"(?:codex-cli )?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?\Z")
_MISSING = object()
_TRUSTED_FAILURE_CODES = frozenset(
    {
        "adapter_timeout",
        "binary_missing",
        "credential_missing",
        "preflight_failed",
        "preflight_timeout",
        "sandbox_failed",
        "spawn_failed",
        "unsupported_protocol",
        "unsupported_version",
        "workspace_invalid",
        "workspace_root_mismatch",
    }
)
_UNCERTAIN_RESULT_CODES = frozenset(
    {
        "adapter_timeout",
        "final_message_too_large",
        "malformed_jsonl",
        "missing_terminal",
        "nonzero_exit",
        "output_too_large",
        "protocol_error",
        "stderr_too_large",
        "stdout_too_large",
        "stream_failure",
        "timeout",
        "transport_failure",
        "turn_failed",
    }
)
ADAPTER_TIMEOUT = 540.0

RUN = OpSpec(
    name="run",
    description="在配置好的工作区中执行一个有界、非交互的 Codex 工作单",
    params={
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
    },
    readonly=False,
    deadline_budget=600.0,
    sensitive_params=("work_order",),
)
STATUS = OpSpec(
    name="status",
    description="读取当前或最近一次 Codex 运行的进程状态",
    params={
        "type": "object",
        "properties": {},
        "additionalProperties": False,
    },
    readonly=True,
    deadline_budget=5.0,
    verifies=(),
    sync_result=True,
)
CODEX_POLICY = HandoffPolicy(
    channel="codex",
    priority=50,
    wake="fast",
    typical_latency=180.0,
    compress_watermark=5,
    progress_via_surrogate=True,
)
CODEX_MANIFEST = ExecutorManifest(
    name="codex",
    ops=(RUN, STATUS),
    policy=CODEX_POLICY,
)


@dataclass(frozen=True, slots=True)
class CodexProcessStatus:
    """Credential-free process evidence emitted by a Codex worker."""

    running: bool
    exited: bool
    terminal: Literal["completed", "failed"] | None = None
    exit_code: int | None = None


@dataclass(frozen=True, slots=True)
class CodexTransportResult:
    classification: Literal["completed", "refused", "uncertain"]
    code: str
    content: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class CodexRunDeadline:
    """One absolute adapter deadline coupled to its monotonic clock."""

    expires_at: float
    clock: Clock

    def remaining(self) -> float:
        return max(0.0, self.expires_at - self.clock.now())


class CodexWorker(Protocol):
    async def run(
        self,
        work_order: str,
        *,
        on_status: Callable[[CodexProcessStatus], None],
        deadline: CodexRunDeadline | None = None,
    ) -> CodexTransportResult: ...

    async def preflight(
        self,
        *,
        deadline: CodexRunDeadline | None = None,
    ) -> Mapping[str, Any]: ...


@dataclass(frozen=True, slots=True)
class CodexStatusSnapshot:
    """Opaque process state retained by the adapter."""

    state: Literal["idle", "running", "exited"] = "idle"
    run_sequence: int = 0
    started_at: float | None = None
    finished_at: float | None = None
    elapsed: float | None = None
    process_running: bool = False
    process_exited: bool = False
    terminal: Literal["completed", "failed"] | None = None
    exit_code: int | None = None
    preflight: Literal["not_run", "passed", "failed"] = "not_run"
    prewarm: Literal["cold", "warming", "ready", "failed"] = "cold"


class CodexAdapterDeadlineExceeded(TimeoutError):
    """System-owned signal that the adapter's aggregate budget expired."""

    code = "adapter_timeout"


async def _await_with_deadline(
    awaitable: Awaitable[Any],
    deadline: CodexRunDeadline,
) -> Any:
    """Enforce wall time while preserving VirtualClock's single-task scheduler."""

    remaining = deadline.remaining()
    if remaining <= 0:
        if asyncio.iscoroutine(awaitable):
            awaitable.close()
        raise CodexAdapterDeadlineExceeded
    if isinstance(deadline.clock, RealClock):
        try:
            async with asyncio.timeout(remaining):
                result = await awaitable
        except TimeoutError:
            if deadline.remaining() <= 0:
                raise CodexAdapterDeadlineExceeded from None
            raise
    else:
        result = await awaitable
    if deadline.remaining() <= 0:
        raise CodexAdapterDeadlineExceeded
    return result


class CodexAdapter:
    manifest = CODEX_MANIFEST

    def __init__(self, worker: CodexWorker) -> None:
        self._worker = worker
        self._run_lock = asyncio.Lock()
        self._status = CodexStatusSnapshot()

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
        deadline = CodexRunDeadline(
            expires_at=started_at + ADAPTER_TIMEOUT,
            clock=ctx.clock,
        )
        sequence = self._status.run_sequence + 1
        preflight_passed = False
        process_started = False
        preflight: dict[str, Any] = {}
        self._status = CodexStatusSnapshot(
            state="running",
            run_sequence=sequence,
            started_at=started_at,
            elapsed=0.0,
        )

        def on_status(process: CodexProcessStatus) -> None:
            nonlocal process_started
            process = _validate_process_status(process)
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
            )

        try:
            remaining = deadline.remaining()
            if remaining <= 0:
                raise CodexAdapterDeadlineExceeded
            raw_preflight = await _await_with_deadline(
                self._worker.preflight(deadline=deadline),
                deadline,
            )
            try:
                preflight = _sanitize_preflight(raw_preflight)
            except Exception:
                self._settle(
                    sequence,
                    started_at,
                    finished_at=ctx.clock.now(),
                    process_started=False,
                    preflight="failed",
                )
                return _run_handoff(
                    outcome="failed",
                    trust="trusted_system",
                    code="invalid_preflight_report",
                    preflight={},
                )
            preflight_passed = True
            self._status = replace(self._status, preflight="passed")
            remaining = deadline.remaining()
            if remaining <= 0:
                raise CodexAdapterDeadlineExceeded
            result = await _await_with_deadline(
                self._worker.run(
                    work_order,
                    on_status=on_status,
                    deadline=deadline,
                ),
                deadline,
            )
            if deadline.remaining() <= 0:
                raise CodexAdapterDeadlineExceeded
        except asyncio.CancelledError:
            self._settle(
                sequence,
                started_at,
                finished_at=ctx.clock.now(),
                process_started=process_started,
                preflight="passed" if preflight_passed else "failed",
            )
            raise
        except CodexAdapterDeadlineExceeded:
            self._settle(
                sequence,
                started_at,
                finished_at=ctx.clock.now(),
                process_started=process_started,
                preflight="passed" if preflight_passed else "failed",
            )
            if process_started:
                return _run_handoff(
                    outcome="unknown",
                    trust="untrusted_external",
                    code="adapter_timeout",
                    preflight=preflight,
                )
            return _run_handoff(
                outcome="failed",
                trust="trusted_system",
                code="adapter_timeout",
                preflight=preflight,
            )
        except Exception as exc:
            before_start = not process_started
            code = _exception_code(
                exc,
                fallback=(
                    "worker_exception_before_start"
                    if before_start
                    else "worker_exception_after_start"
                ),
            )
            self._settle(
                sequence,
                started_at,
                finished_at=ctx.clock.now(),
                process_started=process_started,
                preflight="passed" if preflight_passed else "failed",
            )
            if before_start:
                return _run_handoff(
                    outcome="failed",
                    trust="trusted_system",
                    code=code,
                    preflight=preflight,
                )
            return _run_handoff(
                outcome="unknown",
                trust="untrusted_external",
                code=code,
                preflight=preflight,
            )

        validated_result = _validate_result(result)
        classification = None if validated_result is None else validated_result[0]
        if (
            classification is None
            or (classification == "refused" and process_started)
            or (
                classification in {"completed", "uncertain"}
                and (not process_started or not self._status.process_exited)
            )
            or (
                classification == "completed"
                and (self._status.terminal != "completed" or self._status.exit_code != 0)
            )
            or (
                classification is not None
                and not _evidence_matches_status_and_classification(
                    classification,
                    validated_result[2],
                    self._status,
                )
            )
        ):
            self._settle(
                sequence,
                started_at,
                finished_at=ctx.clock.now(),
                process_started=process_started,
                preflight="passed",
            )
            if process_started:
                return _run_handoff(
                    outcome="unknown",
                    trust="untrusted_external",
                    code="invalid_worker_result",
                    preflight=preflight,
                )
            return _run_handoff(
                outcome="failed",
                trust="trusted_system",
                code="invalid_worker_result",
                preflight=preflight,
            )

        self._settle(
            sequence,
            started_at,
            finished_at=ctx.clock.now(),
            process_started=process_started,
            preflight="passed",
        )
        outcome, trust = _classification(classification)
        return _run_handoff(
            outcome=outcome,
            trust=trust,
            code=validated_result[1],
            preflight=preflight,
            evidence=validated_result[2],
        )

    def _settle(
        self,
        sequence: int,
        started_at: float,
        *,
        finished_at: float,
        process_started: bool,
        preflight: Literal["passed", "failed"],
    ) -> None:
        if self._status.process_exited:
            self._status = replace(
                self._status,
                state="exited",
                finished_at=self._status.finished_at or finished_at,
                elapsed=max(0.0, finished_at - started_at),
                process_running=False,
                preflight=preflight,
            )
            return
        if process_started:
            self._status = replace(
                self._status,
                state="running",
                finished_at=None,
                elapsed=max(0.0, finished_at - started_at),
                preflight=preflight,
            )
            return
        self._status = CodexStatusSnapshot(
            state="idle",
            run_sequence=sequence,
            started_at=started_at,
            finished_at=finished_at,
            elapsed=max(0.0, finished_at - started_at),
            process_running=False,
            process_exited=False,
            terminal=None,
            exit_code=None,
            preflight=preflight,
        )

    def _status_content(self, now: float) -> dict[str, Any]:
        snapshot = self._status
        elapsed = snapshot.elapsed
        if snapshot.state == "running" and snapshot.started_at is not None:
            elapsed = max(0.0, now - snapshot.started_at)
        return {
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
        }


def _normalize_run_request(request: Mapping[str, Any]) -> str | None:
    if set(request) != {"work_order"}:
        return None
    work_order = request.get("work_order")
    if type(work_order) is not str:
        return None
    work_order = work_order.strip()
    if not work_order or len(work_order) > 4000:
        return None
    return work_order


def _classification(
    classification: Literal["completed", "refused", "uncertain"],
) -> tuple[Literal["ok", "failed", "unknown"], Literal["trusted_system", "untrusted_external"]]:
    if classification == "completed":
        return "ok", "untrusted_external"
    if classification == "refused":
        return "failed", "trusted_system"
    return "unknown", "untrusted_external"


def _validate_result(
    result: object,
) -> (
    tuple[
        Literal["completed", "refused", "uncertain"],
        str,
        dict[str, Any],
    ]
    | None
):
    if type(result) is not CodexTransportResult:
        return None
    try:
        classification = result.classification
        if type(classification) is not str or classification not in {
            "completed",
            "refused",
            "uncertain",
        }:
            return None
        if classification == "refused":
            return "refused", "worker_refused", {}
        code = result.code
        if type(code) is not str:
            return None
        content = _sanitize_transport_content(result.content)
        if content is None:
            return None
        if classification == "completed":
            return ("completed", "completed", content) if code == "completed" else None
        return ("uncertain", code, content) if code in _UNCERTAIN_RESULT_CODES else None
    except Exception:
        return None


def _run_handoff(
    *,
    outcome: Literal["ok", "failed", "unknown"],
    trust: Literal["trusted_system", "untrusted_external"],
    code: object,
    preflight: Mapping[str, Any],
    evidence: Mapping[str, Any] | None = None,
) -> Handoff:
    content: dict[str, Any] = {
        "op": "run",
        "worker": "codex",
        "code": _safe_code(code),
    }
    if evidence:
        content.update(evidence)
    content.update(
        {
            "preflight": dict(preflight),
            "goal_verification": "unverified",
        }
    )
    return Handoff(
        outcome=outcome,
        trust=trust,
        content=content,
    )


def _safe_code(value: object) -> str:
    if type(value) is not str or not 1 <= len(value) <= 64:
        return "invalid_worker_code"
    if not value[0].islower() or not all(
        char.islower() or char.isdigit() or char == "_" for char in value
    ):
        return "invalid_worker_code"
    return value


def _sanitize_transport_content(value: object) -> dict[str, Any] | None:
    """Admit only the exact bounded transport envelope; erase everything else."""

    if type(value) is not dict or not value:
        return None
    allowed_keys = {"events", "protocol", "process"}
    if frozenset(value) not in {
        frozenset(allowed_keys),
        frozenset(allowed_keys | {"result"}),
    }:
        return None
    try:
        events = _sanitize_protocol_events(value["events"])
        protocol = _sanitize_protocol_evidence(value["protocol"])
        process = _sanitize_process_evidence(value["process"])
        result = None if "result" not in value else _sanitize_final_message_result(value["result"])
    except Exception:
        return None
    sanitized: dict[str, Any] = {
        "events": events,
        "protocol": protocol,
        "process": process,
    }
    if result is not None:
        sanitized["result"] = result
    return sanitized


def _sanitize_protocol_events(value: object) -> list[dict[str, Any]]:
    if type(value) is not list or len(value) > 16_384:
        raise ValueError("invalid events")
    result: list[dict[str, Any]] = []
    allowed = {
        "thread.started",
        "turn.started",
        "turn.completed",
        "turn.failed",
        "error",
    }
    for event in value:
        if type(event) is not dict:
            raise ValueError("invalid event")
        event_type = event.get("type")
        if type(event_type) is not str:
            raise ValueError("invalid event type")
        if event_type == "internal_activity":
            count = event.get("count")
            if (
                set(event) != {"type", "count"}
                or type(count) is not int
                or not 1 <= count <= 1_048_576
            ):
                raise ValueError("invalid activity")
            result.append({"type": event_type, "count": count})
            continue
        if set(event) != {"type"} or event_type not in allowed:
            raise ValueError("invalid event")
        result.append({"type": event_type})
    return result


def _sanitize_protocol_evidence(value: object) -> dict[str, Any]:
    if type(value) is not dict or set(value) != {
        "thread_started",
        "turn_started",
        "terminal",
        "transport_closed",
        "unknown_event_count",
    }:
        raise ValueError("invalid protocol")
    thread_started = value["thread_started"]
    turn_started = value["turn_started"]
    terminal = value["terminal"]
    transport_closed = value["transport_closed"]
    unknown_count = value["unknown_event_count"]
    if type(thread_started) is not bool or type(turn_started) is not bool:
        raise ValueError("invalid protocol state")
    if terminal is not None and (
        type(terminal) is not str or terminal not in {"completed", "failed"}
    ):
        raise ValueError("invalid terminal")
    if type(transport_closed) is not bool:
        raise ValueError("invalid transport state")
    if type(unknown_count) is not int or not 0 <= unknown_count <= 1_048_576:
        raise ValueError("invalid unknown count")
    return {
        "thread_started": thread_started,
        "turn_started": turn_started,
        "terminal": terminal,
        "transport_closed": transport_closed,
        "unknown_event_count": unknown_count,
    }


def _sanitize_process_evidence(value: object) -> dict[str, Any]:
    if type(value) is not dict or set(value) != {"started", "exit_code", "stop"}:
        raise ValueError("invalid process evidence")
    started = value["started"]
    exit_code = value["exit_code"]
    stop = value["stop"]
    if started is not True:
        raise ValueError("invalid process start")
    if exit_code is not None and type(exit_code) is not int:
        raise ValueError("invalid process exit")
    if type(stop) is not str or stop not in {"none", "terminate", "kill"}:
        raise ValueError("invalid process stop")
    return {
        "started": True,
        "exit_code": exit_code,
        "stop": stop,
    }


def _sanitize_final_message_result(value: object) -> dict[str, Any]:
    if type(value) is not dict or set(value) != {"final_message"}:
        raise ValueError("invalid result")
    message = value["final_message"]
    if type(message) is not dict or set(message) != {
        "text",
        "original_chars",
        "truncated",
        "sha256",
    }:
        raise ValueError("invalid final message")
    text = message["text"]
    original_chars = message["original_chars"]
    truncated = message["truncated"]
    digest = message["sha256"]
    if type(text) is not str or len(text) > 4000:
        raise ValueError("invalid final text")
    if unicodedata.normalize("NFC", text) != text or any(not char.isprintable() for char in text):
        raise ValueError("invalid normalized text")
    if type(original_chars) is not int or not len(text) <= original_chars <= 65_536:
        raise ValueError("invalid original length")
    if type(truncated) is not bool or truncated != (original_chars > len(text)):
        raise ValueError("invalid truncation")
    if (
        type(digest) is not str
        or len(digest) != 64
        or any(char not in "0123456789abcdef" for char in digest)
    ):
        raise ValueError("invalid digest")
    if not truncated and hashlib.sha256(text.encode("utf-8")).hexdigest() != digest:
        raise ValueError("invalid digest evidence")
    return {
        "final_message": {
            "text": text,
            "original_chars": original_chars,
            "truncated": truncated,
            "sha256": digest,
        }
    }


def _evidence_matches_status_and_classification(
    classification: Literal["completed", "refused", "uncertain"],
    evidence: Mapping[str, Any],
    status: CodexStatusSnapshot,
) -> bool:
    if classification == "refused":
        return not evidence
    try:
        events = evidence["events"]
        protocol = evidence["protocol"]
        process = evidence["process"]
        event_types = [event["type"] for event in events]
        if not _canonical_events_match_protocol(event_types, protocol):
            return False
        if process["exit_code"] != status.exit_code:
            return False
        if protocol["terminal"] != status.terminal:
            return False
        if classification == "completed":
            return (
                protocol["thread_started"] is True
                and protocol["turn_started"] is True
                and protocol["terminal"] == "completed"
                and protocol["transport_closed"] is True
                and process["exit_code"] == 0
                and process["stop"] == "none"
                and "result" in evidence
            )
        return True
    except Exception:
        return False


def _canonical_events_match_protocol(
    event_types: list[object],
    protocol: Mapping[str, Any],
) -> bool:
    terminal = protocol["terminal"]
    if not event_types:
        return (
            protocol["thread_started"] is False
            and protocol["turn_started"] is False
            and terminal is None
        )
    if len(event_types) < 3:
        return False
    if event_types[:2] != ["thread.started", "turn.started"]:
        return False
    if protocol["thread_started"] is not True or protocol["turn_started"] is not True:
        return False
    terminal_event = None if terminal is None else f"turn.{terminal}"
    if terminal_event is None or event_types[-1] != terminal_event:
        return False
    middle = event_types[2:-1]
    if middle.count("internal_activity") > 1:
        return False
    if "internal_activity" in middle and middle[-1] != "internal_activity":
        return False
    return all(value in {"error", "internal_activity"} for value in middle)


def _validate_process_status(value: object) -> CodexProcessStatus:
    if type(value) is not CodexProcessStatus:
        raise ValueError("invalid process status")
    if type(value.running) is not bool or type(value.exited) is not bool:
        raise ValueError("invalid process state")
    if value.running == value.exited:
        raise ValueError("process status must be running or exited")
    if value.terminal is not None and (
        type(value.terminal) is not str or value.terminal not in {"completed", "failed"}
    ):
        raise ValueError("invalid protocol terminal")
    if value.exit_code is not None and type(value.exit_code) is not int:
        raise ValueError("invalid process exit code")
    if value.running and (value.terminal is not None or value.exit_code is not None):
        raise ValueError("running process cannot have terminal evidence")
    return value


def _exception_code(exc: Exception, *, fallback: str) -> str:
    try:
        value = getattr(exc, "code", None)
    except Exception:
        return fallback
    if type(value) is not str or value not in _TRUSTED_FAILURE_CODES:
        return fallback
    return value


def _sanitize_preflight(
    value: object,
) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError("preflight report must be a mapping")
    result: dict[str, Any] = {}

    version = _mapping_get(value, "version")
    if version is not _MISSING:
        if type(version) is not str or _CODEX_VERSION.fullmatch(version) is None:
            raise ValueError("invalid Codex version")
        result["version"] = version

    root_matches = _mapping_get(value, "root_matches")
    if root_matches is not _MISSING:
        if not isinstance(root_matches, bool):
            raise ValueError("invalid root verdict")
        result["root_matches"] = root_matches

    for key, expected in (
        ("mount", "workspace_only"),
        ("subprocess", "contained"),
        ("network", "blocked"),
    ):
        verdict = _mapping_get(value, key)
        if verdict is _MISSING:
            continue
        if type(verdict) is not str or verdict != expected:
            raise ValueError(f"invalid {key} verdict")
        result[key] = verdict

    credential = _mapping_get(value, "credential")
    if credential is not _MISSING:
        if not isinstance(credential, Mapping):
            raise ValueError("invalid credential verdict")
        safe_credential: dict[str, Any] = {}
        present = _mapping_get(credential, "present")
        if present is not _MISSING:
            if not isinstance(present, bool):
                raise ValueError("invalid credential presence")
            safe_credential["present"] = present
        identity = _mapping_get(credential, "identity")
        if identity is not _MISSING:
            if type(identity) is not str or identity not in {
                "chatgpt",
                "api_key",
                "unknown",
            }:
                raise ValueError("invalid credential identity")
            safe_credential["identity"] = identity
        policy = _mapping_get(credential, "policy")
        if policy is not _MISSING:
            if type(policy) is not str or policy not in {
                "saved_login",
                "process_only",
            }:
                raise ValueError("invalid credential policy")
            safe_credential["policy"] = policy
        result["credential"] = safe_credential

    limits = _mapping_get(value, "limits")
    if limits is not _MISSING:
        if not isinstance(limits, Mapping):
            raise ValueError("invalid limit verdicts")
        safe_limits: dict[str, str] = {}
        for name, classification in limits.items():
            if (
                type(name) is not str
                or not 1 <= len(name) <= 32
                or not all(char.islower() or char.isdigit() or char == "_" for char in name)
                or type(classification) is not str
                or classification not in {"finite", "unbounded", "unavailable"}
            ):
                raise ValueError("invalid limit verdict")
            safe_limits[name] = classification
        result["limits"] = safe_limits

    return result


def _mapping_get(value: Mapping[str, Any], key: str) -> Any:
    try:
        return value.get(key, _MISSING)
    except Exception as exc:
        raise ValueError("invalid preflight mapping") from exc


def _failure(error: str, op: str) -> Handoff:
    return Handoff(
        outcome="failed",
        trust="trusted_system",
        content={"error": error, "op": op},
    )
