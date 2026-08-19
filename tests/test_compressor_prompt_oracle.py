"""Gate the Python side of compressor-prompt parity.

The compressor serializes memory items straight into its prompt, so key order, float
rendering, and separators are all model-visible. Node asserts the same golden.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.compressor_prompt_oracle import EXPECTED, FIXTURE, main


def test_python_compressor_prompt_matches_the_committed_golden(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main([]) == 0
    assert "parity passed" in capsys.readouterr().out


def test_the_golden_covers_every_declared_scenario() -> None:
    fixture = json.loads(Path(FIXTURE).read_text(encoding="utf-8"))
    expected = json.loads(Path(EXPECTED).read_text(encoding="utf-8"))
    assert {scenario["id"] for scenario in fixture["scenarios"]} == set(expected["prompts"])


def test_the_prompt_pins_both_cross_language_hazards() -> None:
    expected = json.loads(Path(EXPECTED).read_text(encoding="utf-8"))
    sorted_prompt = expected["prompts"]["sorted-keys-and-float-ts"]
    # Code-point key order, which JavaScript would otherwise reorder.
    assert '"10": "ten", "2": "two"' in sorted_prompt
    # Float timestamps keep their decimal point, which a JS number cannot carry.
    assert '"ts": 1.0' in sorted_prompt
    assert expected["prompts"]["empty"] == "[]"
