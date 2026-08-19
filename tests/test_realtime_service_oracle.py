from __future__ import annotations

import json

import pytest

from scripts.realtime_service_oracle import EXPECTED, FIXTURE, main, run_all

pytestmark = pytest.mark.fixture_replay


def test_python_service_matches_the_committed_golden(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["check"]) == 0
    assert "parity passed" in capsys.readouterr().out


def test_every_scenario_declares_what_it_covers() -> None:
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    for scenario in document["scenarios"]:
        assert scenario["covers"], scenario["name"]
        assert scenario["steps"], scenario["name"]


def test_the_scenario_set_exercises_all_three_ordering_fields() -> None:
    # A set that only varied priority would pass with the other two fields deleted from the sort key.
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    covered = {name for scenario in document["scenarios"] for name in scenario["covers"]}
    assert {
        "service.queue_priority",
        "service.queue_fifo_within_priority",
        "service.queue_preemptive_tiebreak",
        "service.priority_clamp",
        "service.armed_preempt",
    } <= covered


def test_no_host_item_can_outrank_the_user() -> None:
    # The clamp is the invariant: whatever a caller asks for, the queue never carries a priority at or
    # above USER_PRIORITY, because nothing the host says outranks the person in the room.
    from nova_audio_agent.memory import USER_PRIORITY

    golden = json.loads(EXPECTED.read_text(encoding="utf-8"))
    for scenario in golden["scenarios"]:
        for step in scenario["steps"]:
            result = step["result"]
            entries = result if isinstance(result, list) else [result]
            for entry in entries:
                if isinstance(entry, dict) and "priority" in entry:
                    assert entry["priority"] < USER_PRIORITY, scenario["name"]


def test_the_golden_is_recomputed_rather_than_trusted() -> None:
    produced = run_all(json.loads(FIXTURE.read_text(encoding="utf-8")))
    committed = json.loads(EXPECTED.read_text(encoding="utf-8"))
    assert produced["scenarios"] == committed["scenarios"]
    assert produced["constants"] == committed["constants"]
