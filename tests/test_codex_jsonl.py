from __future__ import annotations

import json
from pathlib import Path

import pytest

from nova_audio_agent.executors.codex_jsonl import CodexJsonlParser, CodexProtocolError


FIXTURES = Path(__file__).parent / "fixtures" / "codex"


def _parse_fixture(name: str):
    parser = CodexJsonlParser()
    for line in (FIXTURES / name).read_bytes().splitlines(keepends=True):
        parser.feed(line)
    return parser.close()


def test_completed_stream_is_reduced_to_sanitized_milestones() -> None:
    summary = _parse_fixture("completed.jsonl")

    assert summary.events == (
        {"type": "thread.started"},
        {"type": "turn.started"},
        {"type": "internal_activity", "count": 3},
        {"type": "turn.completed"},
    )
    assert summary.thread_started is True
    assert summary.turn_started is True
    assert summary.terminal == "completed"
    assert summary.transport_closed is True
    assert summary.unknown_event_count == 0
    assert summary.internal_activity_count == 3


def test_erases_item_payloads_before_summary_retention() -> None:
    summary = _parse_fixture("malicious-items.jsonl")

    retained = repr(summary)
    for sentinel in (
        "do-not-retain-thread-id",
        "do-not-retain-work-order",
        "do-not-retain-item-id",
        "do-not-retain-tool-name",
        "do-not-retain-token",
        "/do/not/retain/private/path",
        "do-not-retain-reasoning",
        "do-not-retain-command",
        "do-not-retain-output",
        "do-not-retain-final-message",
    ):
        assert sentinel not in retained


def test_error_event_retains_no_external_message() -> None:
    parser = CodexJsonlParser()
    parser.feed(b'{"type":"thread.started"}\n')
    parser.feed(b'{"type":"turn.started"}\n')
    parser.feed(b'{"type":"error","message":"do-not-retain-error-message"}\n')
    parser.feed(b'{"type":"turn.failed"}\n')

    summary = parser.close()

    assert summary.events == (
        {"type": "thread.started"},
        {"type": "turn.started"},
        {"type": "error"},
        {"type": "turn.failed"},
    )
    assert "do-not-retain-error-message" not in repr(summary)


@pytest.mark.parametrize(
    ("line", "code"),
    [
        (b"\xff", "malformed_jsonl"),
        ('{"type":"future.progress"}'.encode("utf-16"), "malformed_jsonl"),
        (b'{"type":', "malformed_jsonl"),
        (b'{"type":"future.progress","value":NaN}', "malformed_jsonl"),
        (b'{"type":"future.progress","value":Infinity}', "malformed_jsonl"),
        (
            b'{"type":"future.progress","value":' + b"9" * 5_000 + b"}",
            "malformed_jsonl",
        ),
        (
            b'{"type":"future.progress","value":' + b"[" * 20_000 + b"0" + b"]" * 20_000 + b"}",
            "malformed_jsonl",
        ),
        (b"[]", "invalid_event"),
        (b"{}", "invalid_event"),
        (b'{"type":42}', "invalid_event_type"),
    ],
)
def test_rejects_malformed_or_non_event_lines(line: bytes, code: str) -> None:
    parser = CodexJsonlParser()

    with pytest.raises(CodexProtocolError) as exc_info:
        parser.feed(line)

    assert exc_info.value.code == code
    assert str(exc_info.value) == code


def test_rejects_line_larger_than_64_kib_before_parsing() -> None:
    parser = CodexJsonlParser()

    with pytest.raises(CodexProtocolError) as exc_info:
        parser.feed(b"x" * (64 * 1024 + 1))

    assert exc_info.value.code == "line_too_large"


def _unknown_line(size: int) -> bytes:
    prefix = b'{"type":"future.progress","padding":"'
    suffix = b'"}\n'
    assert size >= len(prefix) + len(suffix)
    return prefix + b"x" * (size - len(prefix) - len(suffix)) + suffix


def test_accepts_line_at_exact_64_kib_including_newline() -> None:
    parser = CodexJsonlParser()

    parser.feed(_unknown_line(64 * 1024))
    parser.feed(b'{"type":"thread.started"}\n')
    parser.feed(b'{"type":"turn.started"}\n')
    parser.feed(b'{"type":"turn.completed"}\n')

    assert parser.close().unknown_event_count == 1


def test_rejects_stdout_larger_than_1_mib() -> None:
    parser = CodexJsonlParser()
    line = json.dumps(
        {"type": "future.progress", "padding": "x" * 60_000},
        separators=(",", ":"),
    ).encode()
    total = 0

    while total + len(line) <= 1024 * 1024:
        parser.feed(line)
        total += len(line)

    with pytest.raises(CodexProtocolError) as exc_info:
        parser.feed(line)

    assert exc_info.value.code == "stdout_too_large"


def test_accepts_exactly_1_mib_stdout_including_newlines() -> None:
    parser = CodexJsonlParser()
    line = _unknown_line(64 * 1024)

    for _ in range(16):
        parser.feed(line)

    with pytest.raises(CodexProtocolError) as exc_info:
        parser.feed(b'{"type":"future.progress"}\n')

    assert exc_info.value.code == "stdout_too_large"


def test_rejects_turn_before_thread() -> None:
    parser = CodexJsonlParser()

    with pytest.raises(CodexProtocolError) as exc_info:
        parser.feed(b'{"type":"turn.started"}\n')

    assert exc_info.value.code == "turn_before_thread"


def test_rejects_item_outside_active_turn() -> None:
    parser = CodexJsonlParser()
    parser.feed(b'{"type":"thread.started"}\n')

    with pytest.raises(CodexProtocolError) as exc_info:
        parser.feed(b'{"type":"item.started","item":{"secret":"discard-me"}}\n')

    assert exc_info.value.code == "item_outside_turn"
    assert "discard-me" not in str(exc_info.value)


def test_rejects_duplicate_terminal() -> None:
    parser = CodexJsonlParser()
    parser.feed(b'{"type":"thread.started"}\n')
    parser.feed(b'{"type":"turn.started"}\n')
    parser.feed(b'{"type":"turn.completed"}\n')

    with pytest.raises(CodexProtocolError) as exc_info:
        parser.feed(b'{"type":"turn.failed","message":"discard-me"}\n')

    assert exc_info.value.code == "duplicate_terminal"
    assert "discard-me" not in str(exc_info.value)


def test_close_without_terminal_fails_and_closes_transport() -> None:
    parser = CodexJsonlParser()
    parser.feed(b'{"type":"thread.started"}\n')
    parser.feed(b'{"type":"turn.started"}\n')

    with pytest.raises(CodexProtocolError) as exc_info:
        parser.close()

    assert exc_info.value.code == "missing_terminal"
    with pytest.raises(CodexProtocolError) as feed_exc:
        parser.feed(b'{"type":"turn.completed"}\n')
    assert feed_exc.value.code == "transport_closed"


def test_unknown_future_event_is_counted_without_breaking_sequence() -> None:
    parser = CodexJsonlParser()
    parser.feed(b'{"type":"thread.started"}\n')
    parser.feed(b'{"type":"turn.started"}\n')
    parser.feed(b'{"type":"future.progress","secret":"discard-me"}\n')
    parser.feed(b'{"type":"turn.completed"}\n')

    summary = parser.close()

    assert summary.unknown_event_count == 1
    assert summary.events == (
        {"type": "thread.started"},
        {"type": "turn.started"},
        {"type": "turn.completed"},
    )
    assert "future.progress" not in repr(summary)
    assert "discard-me" not in repr(summary)
