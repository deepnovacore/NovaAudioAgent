from __future__ import annotations

import json

import pytest

from scripts.recall_oracle import EXPECTED, FIXTURE, main, run_all

pytestmark = pytest.mark.fixture_replay


def test_python_recall_matches_the_committed_golden(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["check"]) == 0
    assert "parity passed" in capsys.readouterr().out


def test_every_scenario_declares_what_it_covers() -> None:
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    for scenario in document["scenarios"]:
        assert scenario["covers"], scenario["name"]
        assert scenario["query"].strip(), scenario["name"]


def test_the_golden_records_one_result_per_scenario_in_order() -> None:
    scenarios = json.loads(FIXTURE.read_text(encoding="utf-8"))["scenarios"]
    golden = json.loads(EXPECTED.read_text(encoding="utf-8"))["scenarios"]
    assert [entry["name"] for entry in golden] == [entry["name"] for entry in scenarios]


def test_the_golden_covers_both_outcomes_and_a_dropped_hit() -> None:
    # A golden of only happy paths would not pin the rejections or the budget behavior, which are the
    # parts a port is most likely to get wrong.
    golden = json.loads(EXPECTED.read_text(encoding="utf-8"))["scenarios"]
    assert any("error" in entry for entry in golden), "some scenario must be rejected"
    assert any(entry.get("view", {}).get("state") == "empty" for entry in golden), (
        "some scenario must find nothing"
    )
    assert any(entry.get("view", {}).get("omitted", 0) > 0 for entry in golden), (
        "some scenario must omit a hit"
    )
    assert any(
        encoding.get("error") is not None
        for entry in golden
        for encoding in entry.get("encodings", ())
    ), "some budget must be too small for the envelope"


def test_the_recall_view_is_not_recomputed_from_the_golden() -> None:
    # Guards the oracle itself: running the scenarios again must reproduce the committed bytes, so a
    # golden edited by hand fails rather than defining the behavior.
    produced = run_all(json.loads(FIXTURE.read_text(encoding="utf-8"))["scenarios"])
    committed = json.loads(EXPECTED.read_text(encoding="utf-8"))
    assert produced["scenarios"] == committed["scenarios"]
