from __future__ import annotations

import json

import pytest

from scripts.project_confirmation_oracle import EXPECTED, FIXTURE, main, run_all

pytestmark = pytest.mark.fixture_replay


def test_python_confirmation_matches_the_committed_golden(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main(["check"]) == 0
    assert "parity passed" in capsys.readouterr().out


def test_every_scenario_declares_what_it_covers() -> None:
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    for scenario in document["controller"]:
        assert scenario["covers"], scenario["name"]
        assert scenario["steps"], scenario["name"]


def test_structured_cases_cover_confirmation_rejection_and_fail_closed_inputs() -> None:
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    covers = {
        item
        for scenario in document["controller"]
        for item in scenario["covers"]
    }
    assert {
        "confirmation.structured_confirm",
        "confirmation.structured_cancel",
        "confirmation.proposal_id_exact",
        "confirmation.boolean_exact",
        "confirmation.commit_authority_single_use",
    } <= covers


def test_the_golden_is_recomputed_rather_than_trusted() -> None:
    produced = run_all(json.loads(FIXTURE.read_text(encoding="utf-8")))
    committed = json.loads(EXPECTED.read_text(encoding="utf-8"))
    assert produced["controller"] == committed["controller"]
