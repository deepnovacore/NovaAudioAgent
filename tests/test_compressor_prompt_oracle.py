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
    # An integral float renders WITHOUT a decimal point, because prompt_json applies
    # ECMAScript number rules. json.dumps would write 1.0 here, which no JavaScript
    # number can express, so that spelling must not come back.
    assert '"ts": 1}' in sorted_prompt
    assert '"ts": 1.0' not in sorted_prompt
    assert expected["prompts"]["empty"] == "[]"


def test_number_spellings_follow_ecmascript_rules_rather_than_json_dumps() -> None:
    expected = json.loads(Path(EXPECTED).read_text(encoding="utf-8"))
    nested = expected["prompts"]["nested-and-unicode"]
    # json.dumps would have produced 1.0, -0.0, 1e+16, and 1e-05 for these.
    assert '"integral_float": 1' in nested
    assert '"negative_zero": 0' in nested
    assert '"upper": 10000000000000000' in nested
    assert '"lower": 0.00001' in nested
    for rejected in ("1.0,", "-0.0", "1e+16", "1e-05"):
        assert rejected not in nested, rejected
