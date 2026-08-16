"""Opt-in realtime telemetry: timestamped JSONL records for offline percentiles (R101).

All timestamps come from the injected Clock port — this module must never touch wall
time directly. Records are line-buffered so a live session's file is readable while
the process runs; percentile math lives offline under ``scripts/`` where the
wall-clock hygiene scan does not apply.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Protocol

from nova_audio_agent.clock import Clock


class RealtimeTelemetry(Protocol):
    def record(self, kind: str, payload: dict[str, Any]) -> None: ...

    def close(self) -> None: ...


class NullTelemetry:
    """Default recorder: zero cost, no behavior change."""

    def record(self, kind: str, payload: dict[str, Any]) -> None:
        del kind, payload

    def close(self) -> None:
        return None


class JsonlTelemetry:
    """One record per line: {ts, kind, payload}, stamped by the injected clock."""

    def __init__(self, path: str | Path, *, clock: Clock) -> None:
        self._clock = clock
        self._handle = open(path, "w", encoding="utf-8", buffering=1)  # noqa: SIM115

    def record(self, kind: str, payload: dict[str, Any]) -> None:
        self._handle.write(
            json.dumps(
                {"ts": self._clock.now(), "kind": kind, "payload": payload},
                ensure_ascii=False,
                separators=(",", ":"),
            )
            + "\n"
        )

    def close(self) -> None:
        self._handle.close()
