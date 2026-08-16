"""Bounded, credential-free JSONL protocol for the AutoGLM worker."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Literal, Mapping

MAX_LINE_BYTES = 64 * 1024
MAX_STDOUT_BYTES = 1024 * 1024
MAX_RESULT_BYTES = 64 * 1024
_MAX_EVIDENCE_TEXT_BYTES = 128
_MAX_RETAINED_EVENTS = 64
_CODE = re.compile(r"[a-z0-9_]{1,128}\Z")
STATUS_STATES = frozenset({"started", "running", "stopped"})
ACTION_KINDS = frozenset({"tap", "swipe", "input", "home", "wait"})
_FORBIDDEN_FIELDS = frozenset(
    {
        "api_key",
        "apiKey",
        "image",
        "image_base64",
        "reasoning",
        "screenshot",
        "screenshot_base64",
        "thinking",
    }
)


class AutoGlmProtocolError(RuntimeError):
    """A worker line exceeded the reviewed protocol surface."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class AutoGlmWorkerResult:
    """Terminal worker evidence with no model text, pixels, or credentials."""

    outcome: Literal["completed", "failed", "blocked"]
    code: str
    effect_verification: Literal["not_performed"]
    events: tuple[Mapping[str, str], ...]

    def __post_init__(self) -> None:
        if self.outcome not in {"completed", "failed", "blocked"}:
            raise ValueError("invalid_outcome")
        if self.effect_verification != "not_performed":
            raise ValueError("invalid_effect_verification")
        if len(self.code.encode("utf-8")) > MAX_RESULT_BYTES:
            raise ValueError("result_too_large")
        if _CODE.fullmatch(self.code) is None:
            raise ValueError("invalid_result_code")
        if len(_result_bytes(self)) > MAX_RESULT_BYTES:
            raise ValueError("result_too_large")


class AutoGlmJsonlParser:
    """Parse the one small event surface permitted from the isolated worker."""

    def __init__(self) -> None:
        self._events: list[Mapping[str, str]] = []
        self._stdout_bytes = 0
        self._result: AutoGlmWorkerResult | None = None
        self._closed = False

    def feed(self, line: bytes) -> None:
        if self._closed:
            raise AutoGlmProtocolError("transport_closed")
        if len(line) > MAX_LINE_BYTES:
            raise AutoGlmProtocolError("line_too_large")
        if self._stdout_bytes + len(line) > MAX_STDOUT_BYTES:
            raise AutoGlmProtocolError("stdout_too_large")
        self._stdout_bytes += len(line)
        try:
            event = json.loads(line.decode("utf-8"), parse_constant=_reject_json_constant)
        except (UnicodeDecodeError, ValueError, RecursionError):
            raise AutoGlmProtocolError("malformed_jsonl") from None
        if not isinstance(event, dict) or not event:
            raise AutoGlmProtocolError("invalid_event")
        if _has_forbidden_field(event):
            raise AutoGlmProtocolError("forbidden_field")
        if self._result is not None:
            raise AutoGlmProtocolError("event_after_result")

        event_type = event.get("type")
        if not isinstance(event_type, str):
            raise AutoGlmProtocolError("invalid_event")
        if event_type == "result":
            self._result = _result(event, self._events)
        else:
            self._append_evidence(_sanitize_worker_event(event))

    def close(self) -> AutoGlmWorkerResult:
        if self._closed:
            raise AutoGlmProtocolError("transport_closed")
        self._closed = True
        if self._result is None:
            raise AutoGlmProtocolError("missing_result")
        return self._result

    def _append_evidence(self, event: Mapping[str, str]) -> None:
        if len(self._events) < _MAX_RETAINED_EVENTS:
            self._events.append(event)


def _evidence(event: Mapping[str, Any], field: str) -> Mapping[str, str]:
    if set(event) != {"type", field}:
        raise AutoGlmProtocolError("invalid_event")
    value = event.get(field)
    if not isinstance(value, str) or len(value.encode("utf-8")) > _MAX_EVIDENCE_TEXT_BYTES:
        raise AutoGlmProtocolError("invalid_event")
    if field == "state" and value not in STATUS_STATES:
        raise AutoGlmProtocolError("invalid_event")
    if field == "kind" and value not in ACTION_KINDS:
        raise AutoGlmProtocolError("invalid_event")
    if field == "code" and _CODE.fullmatch(value) is None:
        raise AutoGlmProtocolError("invalid_event")
    return {"type": event["type"], field: value}


def sanitize_worker_events(events: object) -> tuple[Mapping[str, str], ...]:
    """Reapply the retained-event protocol at every worker-result boundary."""

    if type(events) is not tuple or len(events) > _MAX_RETAINED_EVENTS:
        raise AutoGlmProtocolError("invalid_event")
    return tuple(_sanitize_worker_event(event) for event in events)


def _sanitize_worker_event(event: object) -> Mapping[str, str]:
    if type(event) is not dict or not event:
        raise AutoGlmProtocolError("invalid_event")
    if _has_forbidden_field(event):
        raise AutoGlmProtocolError("forbidden_field")
    event_type = event.get("type")
    if event_type == "status":
        return _evidence(event, "state")
    if event_type == "action":
        return _evidence(event, "kind")
    if event_type in {"blocked", "error"}:
        return _evidence(event, "code")
    raise AutoGlmProtocolError("unknown_event")


def _result(event: Mapping[str, Any], events: list[Mapping[str, str]]) -> AutoGlmWorkerResult:
    if set(event) != {"type", "outcome", "code", "effect_verification"}:
        raise AutoGlmProtocolError("invalid_result")
    outcome = event.get("outcome")
    code = event.get("code")
    effect_verification = event.get("effect_verification")
    if (
        outcome not in {"completed", "failed", "blocked"}
        or not isinstance(code, str)
        or effect_verification != "not_performed"
    ):
        raise AutoGlmProtocolError("invalid_result")
    try:
        return AutoGlmWorkerResult(
            outcome=outcome,
            code=code,
            effect_verification=effect_verification,
            events=tuple(events),
        )
    except ValueError as exc:
        raise AutoGlmProtocolError(str(exc)) from None


def _result_bytes(result: AutoGlmWorkerResult) -> bytes:
    return json.dumps(
        {
            "outcome": result.outcome,
            "code": result.code,
            "effect_verification": result.effect_verification,
            "events": result.events,
        },
        separators=(",", ":"),
    ).encode("utf-8")


def _has_forbidden_field(value: object) -> bool:
    if isinstance(value, dict):
        return any(
            key in _FORBIDDEN_FIELDS or _has_forbidden_field(item) for key, item in value.items()
        )
    if isinstance(value, list):
        return any(_has_forbidden_field(item) for item in value)
    return False


def _reject_json_constant(_value: str) -> None:
    raise ValueError("non-standard JSON constant")
