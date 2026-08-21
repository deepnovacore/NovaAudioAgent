from __future__ import annotations

import json

import pytest

from scripts.volcengine_protocol_oracle import EXPECTED, FIXTURE, main


def test_python_volcengine_protocol_matches_the_committed_golden(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main([]) == 0
    assert "parity passed" in capsys.readouterr().out


def test_golden_has_exactly_one_result_for_every_declared_scenario() -> None:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    expected = json.loads(EXPECTED.read_text(encoding="utf-8"))
    for group in ("config", "asr_encode", "asr_decode", "tts_codec", "text_chunker"):
        declared = [scenario["id"] for scenario in fixture[group]]
        assert len(declared) == len(set(declared))
        assert set(declared) == set(expected[group])


def test_golden_never_contains_credentials_or_provider_prose() -> None:
    rendered = EXPECTED.read_text(encoding="utf-8")
    for forbidden in (
        "fixture-ark-key",
        "fixture-asr-key",
        "fixture-tts-key",
        "sentinel-provider-secret",
        "sentinel-provider-message",
    ):
        assert forbidden not in rendered


def test_check_mode_never_writes_the_expected_file() -> None:
    before = EXPECTED.read_bytes()
    assert main([]) == 0
    assert EXPECTED.read_bytes() == before
