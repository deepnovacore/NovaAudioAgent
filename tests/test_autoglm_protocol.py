from __future__ import annotations

import json

import pytest

from nova_audio_agent.executors.autoglm_protocol import (
    MAX_LINE_BYTES,
    MAX_RESULT_BYTES,
    MAX_STDOUT_BYTES,
    AutoGlmJsonlParser,
    AutoGlmProtocolError,
    AutoGlmWorkerResult,
)


def _event(event_type: str, **fields: object) -> bytes:
    return (json.dumps({"type": event_type, **fields}, separators=(",", ":")) + "\n").encode()


def _completed_stream(parser: AutoGlmJsonlParser) -> AutoGlmWorkerResult:
    parser.feed(_event("status", state="started"))
    parser.feed(_event("action", kind="tap"))
    parser.feed(
        _event(
            "result",
            outcome="completed",
            code="completed",
            effect_verification="not_performed",
        )
    )
    return parser.close()


def test_parser_keeps_only_the_accepted_bounded_event_envelope() -> None:
    result = _completed_stream(AutoGlmJsonlParser())

    assert result == AutoGlmWorkerResult(
        outcome="completed",
        code="completed",
        effect_verification="not_performed",
        events=(
            {"type": "status", "state": "started"},
            {"type": "action", "kind": "tap"},
        ),
    )


@pytest.mark.parametrize(
    "line",
    [
        _event("status", state="autoglm-test-secret"),
        _event("action", kind="autoglm-test-secret"),
    ],
)
def test_parser_rejects_free_form_evidence_values(line: bytes) -> None:
    parser = AutoGlmJsonlParser()

    with pytest.raises(AutoGlmProtocolError, match="invalid_event"):
        parser.feed(line)


@pytest.mark.parametrize(
    "event",
    [
        _event("blocked", code="sensitive_action"),
        _event("error", code="agent_error"),
    ],
)
def test_parser_accepts_bounded_terminal_evidence_events(event: bytes) -> None:
    parser = AutoGlmJsonlParser()
    parser.feed(event)
    parser.feed(
        _event(
            "result",
            outcome="failed",
            code="agent_error",
            effect_verification="not_performed",
        )
    )

    result = parser.close()

    assert result.events == (
        {"type": json.loads(event)["type"], "code": json.loads(event)["code"]},
    )
    assert result.outcome == "failed"


@pytest.mark.parametrize(
    ("line", "code"),
    [
        (b'{"type":', "malformed_jsonl"),
        (b'{"type":"status","state":NaN}', "malformed_jsonl"),
        (b"[]", "invalid_event"),
        (_event("future", state="started"), "unknown_event"),
        (_event("status", state="started", detail="discard"), "invalid_event"),
        (_event("status", state="started", thinking="do-not-retain"), "forbidden_field"),
        (_event("action", kind="tap", screenshot="base64-pixels"), "forbidden_field"),
        (_event("error", code="bad", api_key="secret"), "forbidden_field"),
    ],
)
def test_parser_rejects_malformed_unknown_or_secret_bearing_events(line: bytes, code: str) -> None:
    parser = AutoGlmJsonlParser()

    with pytest.raises(AutoGlmProtocolError) as raised:
        parser.feed(line)

    assert raised.value.code == code
    assert "do-not-retain" not in repr(raised.value)
    assert "base64-pixels" not in repr(raised.value)
    assert "secret" not in repr(raised.value)


def test_parser_enforces_per_line_and_aggregate_stdout_limits() -> None:
    parser = AutoGlmJsonlParser()

    with pytest.raises(AutoGlmProtocolError, match="line_too_large"):
        parser.feed(b"x" * (MAX_LINE_BYTES + 1))

    line = _event("status", state="started")
    assert len(line) <= MAX_LINE_BYTES
    for _ in range(MAX_STDOUT_BYTES // len(line)):
        parser.feed(line)

    with pytest.raises(AutoGlmProtocolError, match="stdout_too_large"):
        parser.feed(line)


def test_parser_requires_one_terminal_result() -> None:
    parser = AutoGlmJsonlParser()
    parser.feed(_event("status", state="started"))

    with pytest.raises(AutoGlmProtocolError, match="missing_result"):
        parser.close()


def test_worker_result_rejects_unbounded_or_unverified_envelopes() -> None:
    with pytest.raises(ValueError, match="result_too_large"):
        AutoGlmWorkerResult(
            outcome="completed",
            code="x" * (MAX_RESULT_BYTES + 1),
            effect_verification="not_performed",
            events=(),
        )

    with pytest.raises(ValueError, match="invalid_effect_verification"):
        AutoGlmWorkerResult(
            outcome="completed",
            code="completed",
            effect_verification="verified",
            events=(),
        )
