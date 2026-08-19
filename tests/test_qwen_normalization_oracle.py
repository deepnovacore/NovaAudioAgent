"""Gate the Python side of Qwen frame-normalization parity.

The Node runtime asserts the same committed golden. Both halves compare against
the same bytes, so agreement is transitive; neither may regenerate a golden
without the other leg passing in the same commit.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.qwen_normalization_oracle import EXPECTED, FIXTURE, main


def test_python_qwen_normalization_matches_the_committed_golden(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main([]) == 0
    assert "parity passed" in capsys.readouterr().out


def test_the_golden_covers_every_declared_scenario() -> None:
    fixture = json.loads(Path(FIXTURE).read_text(encoding="utf-8"))
    expected = json.loads(Path(EXPECTED).read_text(encoding="utf-8"))
    declared = {scenario["id"] for scenario in fixture["scenarios"]}
    assert declared == set(expected["scenarios"])
    assert fixture["schema_version"] == expected["schema_version"]


def test_every_scenario_produces_at_least_one_neutral_event() -> None:
    expected = json.loads(Path(EXPECTED).read_text(encoding="utf-8"))
    for scenario_id, events in expected["scenarios"].items():
        assert events, f"{scenario_id} recorded no events"
        for event in events:
            assert isinstance(event.get("kind"), str)
            assert event.get("session_epoch") == 1


def test_no_golden_event_carries_provider_prose_or_credentials() -> None:
    # Provider error taxonomy must stay a bounded category, never echoed text.
    rendered = Path(EXPECTED).read_text(encoding="utf-8")
    assert "fixture-key" not in rendered
    assert "rate limit/exceeded" not in rendered
    assert "not.in.allowlist" not in rendered
