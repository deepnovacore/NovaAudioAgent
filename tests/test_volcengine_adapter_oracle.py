from __future__ import annotations

import json

import pytest

from scripts.volcengine_adapter_oracle import EXPECTED, FIXTURE, main, produce

pytestmark = pytest.mark.fixture_replay


REQUIRED_COVERAGE = {
    "text_happy_tts_prewarm_final",
    "tool_only",
    "mixed_text_then_tool",
    "mixed_tool_then_text",
    "blank_final_asr",
    "asr_start_failure_recovers",
    "asr_append_failure_recovers",
    "asr_finish_failure_recovers",
    "asr_receive_failure_recovers",
    "pending_order_duplicate_consumed",
    "response_continuation",
    "unresolved_tool_reset_late_output",
    "tts_retry_before_audio",
    "tts_no_retry_after_audio",
    "exact_and_mismatched_cancel",
    "close_during_asr",
    "close_during_response",
}


def test_python_adapter_matches_the_committed_golden(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main(["--check"]) == 0
    assert "parity passed" in capsys.readouterr().out


def test_fixture_covers_every_required_adapter_behavior() -> None:
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    names = [scenario["name"] for scenario in document["scenarios"]]
    assert len(names) == len(set(names))
    covered = {cover for scenario in document["scenarios"] for cover in scenario["covers"]}
    assert REQUIRED_COVERAGE <= covered


def test_production_adapter_executes_every_declared_scenario() -> None:
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    produced = produce(document)
    assert [row["name"] for row in produced["scenarios"]] == [
        scenario["name"] for scenario in document["scenarios"]
    ]


def test_check_mode_never_rewrites_the_exporter_owned_golden() -> None:
    if not EXPECTED.is_file():
        pytest.skip("RED phase has no generated golden yet")
    before = EXPECTED.read_bytes()
    main(["--check"])
    assert EXPECTED.read_bytes() == before


def test_expected_output_never_leaks_the_scripted_provider_secret() -> None:
    if not EXPECTED.is_file():
        pytest.skip("RED phase has no generated golden yet")
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    produced = json.dumps(produce(document), ensure_ascii=False)
    assert "sentinel-provider-secret" not in produced
    assert "sentinel-provider-secret" not in EXPECTED.read_text(encoding="utf-8")
