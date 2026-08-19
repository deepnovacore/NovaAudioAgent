"""Gate the Python side of prompt-rendering parity.

The Node runtime asserts the same committed golden, so agreement is transitive
through these bytes. Prompts are model-visible behavior: an earlier hand-copied
prompt constant in this migration silently dropped three quarters of its content,
which is why the whole rendered output is pinned rather than spot-checked.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.prompt_render_oracle import EXPECTED, FIXTURE, main


def test_python_prompt_rendering_matches_the_committed_golden(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main([]) == 0
    assert "parity passed" in capsys.readouterr().out


def test_the_golden_covers_every_declared_scenario_and_is_not_vacuous() -> None:
    fixture = json.loads(Path(FIXTURE).read_text(encoding="utf-8"))
    expected = json.loads(Path(EXPECTED).read_text(encoding="utf-8"))
    declared = {scenario["id"] for scenario in fixture["scenarios"]}
    assert declared == set(expected["rendered"])
    for scenario_id, rendered in expected["rendered"].items():
        assert rendered["plain"].startswith("# 现在 t="), scenario_id
        assert "## 意图" in rendered["plain"], scenario_id
        assert rendered["with_trigger"] != rendered["plain"] or "trigger" not in scenario_id


def test_every_system_prompt_in_the_golden_is_substantial() -> None:
    expected = json.loads(Path(EXPECTED).read_text(encoding="utf-8"))
    systems = expected["systems"]
    assert len(systems["fastbrain"].splitlines()) >= 15
    assert len(systems["fastbrain_live"].splitlines()) >= 30
    assert len(systems["surrogate"].splitlines()) >= 10
    assert systems["compressor"].strip()


def test_rendered_content_keys_are_sorted_so_the_order_is_language_neutral() -> None:
    expected = json.loads(Path(EXPECTED).read_text(encoding="utf-8"))
    rendered = expected["rendered"]["integer-like-content-keys"]["plain"]
    # Insertion order was 10, 2, b, a; code-point order is 10, 2, a, b.
    assert '{"10": "ten", "2": "two", "a": 2, "b": 1}' in rendered
