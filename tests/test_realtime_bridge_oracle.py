from __future__ import annotations

import json

import pytest

from scripts.realtime_bridge_oracle import EXPECTED, FIXTURE, main, run_all

pytestmark = pytest.mark.fixture_replay


def test_python_bridge_matches_the_committed_golden(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["check"]) == 0
    assert "parity passed" in capsys.readouterr().out


def test_every_scenario_declares_what_it_covers() -> None:
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    for scenario in document["scenarios"]:
        assert scenario["covers"], scenario["name"]
        assert scenario["steps"], scenario["name"]
        assert scenario["manifests"], scenario["name"]


def test_the_scenario_set_reaches_every_acceptance_code() -> None:
    # Most of this module is refusal, and each refusal code is a different thing the model is not
    # allowed to do. A set that only exercised the happy path would prove nothing.
    golden = json.loads(EXPECTED.read_text(encoding="utf-8"))
    codes = {
        step["result"]["code"]
        for scenario in golden["scenarios"]
        for step in scenario["steps"]
        if isinstance(step["result"], dict) and "code" in step["result"]
    }
    assert {
        "accepted",
        "completed",
        "ok",
        "unknown_tool",
        "invalid_params",
        "missing_origin_ref",
        "runtime_rejected",
    } <= codes


def test_a_refused_call_still_carries_a_tool_result() -> None:
    # A provider left without a result for a call it made stalls waiting for one, so a refusal has to
    # be shaped like an answer rather than like silence.
    golden = json.loads(EXPECTED.read_text(encoding="utf-8"))
    for scenario in golden["scenarios"]:
        for step in scenario["steps"]:
            result = step["result"]
            if not isinstance(result, dict) or result.get("accepted") is not False:
                continue
            assert result["host_item"]["kind"] == "tool_output"
            assert result["response_intent"]["kind"] == "tool_result"
            assert result["host_item"]["call_id"], scenario["name"]


def test_the_golden_is_recomputed_rather_than_trusted() -> None:
    produced = run_all(json.loads(FIXTURE.read_text(encoding="utf-8")))
    committed = json.loads(EXPECTED.read_text(encoding="utf-8"))
    assert produced["scenarios"] == committed["scenarios"]
