from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Literal, Mapping


class CodexProtocolError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class CodexProtocolSummary:
    events: tuple[Mapping[str, Any], ...]
    thread_started: bool
    turn_started: bool
    terminal: Literal["completed", "failed"] | None
    transport_closed: bool
    unknown_event_count: int
    internal_activity_count: int


class CodexJsonlParser:
    MAX_LINE_BYTES = 64 * 1024
    MAX_STDOUT_BYTES = 1024 * 1024

    _MILESTONES = {
        "thread.started",
        "turn.started",
        "turn.completed",
        "turn.failed",
        "error",
    }
    _ITEM_EVENTS = {"item.started", "item.updated", "item.completed"}

    def __init__(self) -> None:
        self._events: list[Mapping[str, Any]] = []
        self._thread_started = False
        self._turn_started = False
        self._terminal: Literal["completed", "failed"] | None = None
        self._transport_closed = False
        self._unknown_event_count = 0
        self._internal_activity_count = 0
        self._stdout_bytes = 0

    def feed(self, line: bytes) -> None:
        if self._transport_closed:
            raise CodexProtocolError("transport_closed")
        if len(line) > self.MAX_LINE_BYTES:
            raise CodexProtocolError("line_too_large")
        if self._stdout_bytes + len(line) > self.MAX_STDOUT_BYTES:
            raise CodexProtocolError("stdout_too_large")
        self._stdout_bytes += len(line)

        try:
            text = line.decode("utf-8")
            event = json.loads(text, parse_constant=_reject_json_constant)
        except (UnicodeDecodeError, ValueError, RecursionError):
            raise CodexProtocolError("malformed_jsonl") from None
        if not isinstance(event, dict) or not event:
            raise CodexProtocolError("invalid_event")

        event_type = event.get("type")
        if not isinstance(event_type, str):
            raise CodexProtocolError("invalid_event_type")

        if event_type in self._ITEM_EVENTS:
            if not self._turn_started or self._terminal is not None:
                raise CodexProtocolError("item_outside_turn")
            self._internal_activity_count += 1
            return
        if event_type not in self._MILESTONES:
            self._unknown_event_count += 1
            return

        if event_type == "thread.started":
            if self._thread_started:
                raise CodexProtocolError("duplicate_thread")
            if self._turn_started or self._terminal is not None:
                raise CodexProtocolError("thread_out_of_order")
            self._thread_started = True
        elif event_type == "turn.started":
            if not self._thread_started:
                raise CodexProtocolError("turn_before_thread")
            if self._turn_started or self._terminal is not None:
                raise CodexProtocolError("duplicate_turn")
            self._turn_started = True
        elif event_type == "turn.completed":
            self._require_active_turn_for_terminal()
            self._append_internal_activity()
            self._terminal = "completed"
        elif event_type == "turn.failed":
            self._require_active_turn_for_terminal()
            self._append_internal_activity()
            self._terminal = "failed"

        self._events.append({"type": event_type})

    def close(self) -> CodexProtocolSummary:
        if self._transport_closed:
            raise CodexProtocolError("transport_closed")
        self._transport_closed = True
        if self._terminal is None:
            raise CodexProtocolError("missing_terminal")
        return CodexProtocolSummary(
            events=tuple(self._events),
            thread_started=self._thread_started,
            turn_started=self._turn_started,
            terminal=self._terminal,
            transport_closed=self._transport_closed,
            unknown_event_count=self._unknown_event_count,
            internal_activity_count=self._internal_activity_count,
        )

    def _append_internal_activity(self) -> None:
        if self._internal_activity_count:
            self._events.append(
                {
                    "type": "internal_activity",
                    "count": self._internal_activity_count,
                }
            )

    def _require_active_turn_for_terminal(self) -> None:
        if self._terminal is not None:
            raise CodexProtocolError("duplicate_terminal")
        if not self._turn_started:
            raise CodexProtocolError("terminal_without_turn")


def _reject_json_constant(_value: str) -> None:
    raise ValueError("non-standard JSON constant")
