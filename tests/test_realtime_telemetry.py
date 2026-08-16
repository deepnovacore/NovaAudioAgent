from __future__ import annotations

import json
from pathlib import Path

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.realtime.telemetry import JsonlTelemetry, NullTelemetry


def test_jsonl_telemetry_stamps_records_with_the_injected_clock(tmp_path: Path) -> None:
    clock = VirtualClock(start=5.0)
    path = tmp_path / "telemetry.jsonl"
    telemetry = JsonlTelemetry(path, clock=clock)

    telemetry.record("provider.response_started", {"response_id": "response-1"})
    clock.advance_to(6.5)
    telemetry.record("renderer.ack", {"kind": "playback_started", "t_render_ms": 120.5})
    telemetry.close()

    lines = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    assert lines == [
        {
            "ts": 5.0,
            "kind": "provider.response_started",
            "payload": {"response_id": "response-1"},
        },
        {
            "ts": 6.5,
            "kind": "renderer.ack",
            "payload": {"kind": "playback_started", "t_render_ms": 120.5},
        },
    ]


def test_jsonl_telemetry_is_readable_before_close(tmp_path: Path) -> None:
    clock = VirtualClock()
    path = tmp_path / "telemetry.jsonl"
    telemetry = JsonlTelemetry(path, clock=clock)

    telemetry.record("mic.uplink_summary", {"frames": 3, "bytes": 96})

    assert path.read_text(encoding="utf-8").count("\n") == 1
    telemetry.close()


def test_null_telemetry_discards_everything() -> None:
    telemetry = NullTelemetry()

    telemetry.record("anything", {"value": 1})
    telemetry.close()
