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


def test_the_classifier_set_exercises_all_three_verdicts() -> None:
    # A set of only positives would prove nothing. What matters is that speech which merely sounds
    # affirmative does not confirm, so all three verdicts have to be represented.
    golden = json.loads(EXPECTED.read_text(encoding="utf-8"))
    verdicts = {entry["verdict"] for entry in golden["classifier"]}
    assert verdicts == {"confirm", "cancel", "unknown"}


def test_a_confirmable_phrase_never_contains_a_refusal() -> None:
    # The property the check order rests on, asserted against the module's own lists. If a phrase is
    # ever added that satisfies both, the order in `classify_confirmation` becomes load-bearing and
    # this fails rather than the safety silently depending on it.
    from nova_audio_agent.realtime.project_confirmation import (
        _LEADING,
        _NEGATIVE,
        _POSITIVE,
        _TRAILING,
    )

    confirmable = set(_POSITIVE)
    for positive in _POSITIVE:
        for filler in _LEADING:
            confirmable.add(filler + positive)
        for filler in _TRAILING:
            confirmable.add(positive + filler)
        for before in _LEADING:
            for after in _TRAILING:
                confirmable.add(before + positive + after)
    unsafe = sorted(
        phrase for phrase in confirmable if any(negative in phrase for negative in _NEGATIVE)
    )
    assert unsafe == []


def test_the_golden_is_recomputed_rather_than_trusted() -> None:
    produced = run_all(json.loads(FIXTURE.read_text(encoding="utf-8")))
    committed = json.loads(EXPECTED.read_text(encoding="utf-8"))
    assert produced["classifier"] == committed["classifier"]
    assert produced["controller"] == committed["controller"]
