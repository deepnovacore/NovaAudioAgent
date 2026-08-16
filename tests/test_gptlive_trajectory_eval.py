from __future__ import annotations

import importlib
import json
from copy import deepcopy
from pathlib import Path
from types import ModuleType

import pytest


FIXTURE = Path(__file__).parent / "fixtures" / "gptlive" / "tetris_same_turn.jsonl"


def _evaluation_module() -> ModuleType:
    try:
        return importlib.import_module("nova_audio_agent.evals.trajectory")
    except ModuleNotFoundError:
        pytest.fail("the offline GPT-Live trajectory evaluator has not been implemented")


def _records() -> list[dict[str, object]]:
    return [json.loads(line) for line in FIXTURE.read_text(encoding="utf-8").splitlines()]


def _finding_codes(report: object) -> set[str]:
    return {finding.code for finding in report.findings}  # type: ignore[attr-defined]


def _renumber_times(records: list[dict[str, object]]) -> None:
    for index, record in enumerate(records):
        record["t_ms"] = index * 100


def test_tetris_fixture_satisfies_the_minimal_same_turn_contract() -> None:
    evaluator = _evaluation_module()

    report = evaluator.evaluate_same_turn_trajectory(_records())

    assert report.passed is True
    assert report.findings == ()


def test_steer_must_target_the_turn_that_was_already_started() -> None:
    evaluator = _evaluation_module()
    records = deepcopy(_records())
    steer = next(record for record in records if record["kind"] == "fast_brain.tool.codex_steer")
    steer["data"]["target"] = "future_turn"  # type: ignore[index]

    report = evaluator.evaluate_same_turn_trajectory(records)

    assert "steer_turn_mismatch" in _finding_codes(report)


def test_progress_remains_owned_by_the_run_delegate() -> None:
    evaluator = _evaluation_module()
    records = deepcopy(_records())
    working = next(
        record
        for record in records
        if record["kind"] == "codex.progress" and record["data"]["phase"] == "working"  # type: ignore[index]
    )
    working["data"]["delegate_id"] = "d-steer"  # type: ignore[index]

    report = evaluator.evaluate_same_turn_trajectory(records)

    assert "progress_identity_mismatch" in _finding_codes(report)


def test_final_handoff_remains_owned_by_the_run_delegate() -> None:
    evaluator = _evaluation_module()
    records = deepcopy(_records())
    final_handoff = next(
        record
        for record in records
        if record["kind"] == "handoff" and record["data"]["outcome"] == "ok"  # type: ignore[index]
    )
    final_handoff["data"]["delegate_id"] = "d-steer"  # type: ignore[index]

    report = evaluator.evaluate_same_turn_trajectory(records)

    assert "run_final_handoff_missing" in _finding_codes(report)


def test_failed_artifact_gate_is_a_hard_failure() -> None:
    evaluator = _evaluation_module()
    records = deepcopy(_records())
    speed_gate = next(
        record
        for record in records
        if record["kind"] == "artifact.gate" and record["data"]["name"] == "steered_speed_control"  # type: ignore[index]
    )
    speed_gate["data"]["passed"] = False  # type: ignore[index]

    report = evaluator.evaluate_same_turn_trajectory(records)

    assert "artifact_gate_failed" in _finding_codes(report)


def test_judge_view_keeps_dialogue_but_drops_private_and_unapproved_payloads() -> None:
    evaluator = _evaluation_module()
    records = deepcopy(_records())
    progress = next(record for record in records if record["kind"] == "codex.progress")
    progress["data"]["raw_command"] = "secret command"  # type: ignore[index]

    view = evaluator.build_judge_view(records)
    encoded = json.dumps(view, ensure_ascii=False)

    assert "写一个俄罗斯方块" in encoded
    assert "private_reasoning" not in encoded
    assert "never send this to the judge" not in encoded
    assert "raw_command" not in encoded
    assert "secret command" not in encoded


def test_judge_evidence_must_reference_an_event_in_the_sanitized_view() -> None:
    evaluator = _evaluation_module()
    view = evaluator.build_judge_view(_records())
    output = {
        "verdict": "finding",
        "scores": {"responsiveness": 3},
        "evidence_refs": ["e007", "missing-event"],
        "summary": "The steering acknowledgement was useful.",
    }

    findings = evaluator.validate_judge_output(output, view)

    assert {finding.code for finding in findings} == {"judge_unknown_evidence_ref"}


def test_the_fixture_must_contain_exactly_one_run() -> None:
    evaluator = _evaluation_module()
    records = deepcopy(_records())
    run = next(record for record in records if record["kind"] == "fast_brain.tool.codex_run")
    records.insert(3, deepcopy(run))
    records[3]["event_ref"] = "duplicate-run"
    _renumber_times(records)

    report = evaluator.evaluate_same_turn_trajectory(records)

    assert "unexpected_run_count" in _finding_codes(report)


@pytest.mark.parametrize(
    ("kind", "field", "value", "expected_code"),
    [
        ("codex.turn_started", "delegate_id", "other-run", "turn_start_identity_mismatch"),
        (
            "codex.turn_completed",
            "correlation",
            "unverified",
            "turn_completion_identity_mismatch",
        ),
        ("codex.turn_completed", "outcome", "error", "turn_completion_not_ok"),
        ("codex.steer_accepted", "status", "stale_turn", "steer_not_accepted"),
        (
            "codex.steer_accepted",
            "correlation",
            "unverified",
            "steer_acceptance_identity_mismatch",
        ),
    ],
)
def test_lifecycle_identity_and_status_are_hard_gates(
    kind: str, field: str, value: str, expected_code: str
) -> None:
    evaluator = _evaluation_module()
    records = deepcopy(_records())
    event = next(record for record in records if record["kind"] == kind)
    event["data"][field] = value  # type: ignore[index]

    report = evaluator.evaluate_same_turn_trajectory(records)

    assert expected_code in _finding_codes(report)


def test_codex_steer_must_be_caused_by_a_user_steering_input() -> None:
    evaluator = _evaluation_module()
    records = [
        record
        for record in deepcopy(_records())
        if not (record["kind"] == "user.input" and record["data"].get("purpose") == "steer")  # type: ignore[union-attr]
    ]

    report = evaluator.evaluate_same_turn_trajectory(records)

    assert "steering_input_missing" in _finding_codes(report)


def test_steer_handoff_must_follow_acceptance_and_precede_completion() -> None:
    evaluator = _evaluation_module()
    records = deepcopy(_records())
    handoff = next(record for record in records if record["event_ref"] == "e010")
    records.remove(handoff)
    steer_index = next(
        index
        for index, record in enumerate(records)
        if record["kind"] == "fast_brain.tool.codex_steer"
    )
    records.insert(steer_index, handoff)
    _renumber_times(records)

    report = evaluator.evaluate_same_turn_trajectory(records)

    assert "steer_handoff_order" in _finding_codes(report)


def test_final_handoff_must_follow_turn_completion() -> None:
    evaluator = _evaluation_module()
    records = deepcopy(_records())
    handoff = next(record for record in records if record["event_ref"] == "e016")
    records.remove(handoff)
    completion_index = next(
        index for index, record in enumerate(records) if record["kind"] == "codex.turn_completed"
    )
    records.insert(completion_index, handoff)
    _renumber_times(records)

    report = evaluator.evaluate_same_turn_trajectory(records)

    assert "run_handoff_order" in _finding_codes(report)


def test_artifact_gates_run_only_after_the_turn_completes() -> None:
    evaluator = _evaluation_module()
    records = deepcopy(_records())
    gates = [record for record in records if record["kind"] == "artifact.gate"]
    records = [record for record in records if record["kind"] != "artifact.gate"]
    completion_index = next(
        index for index, record in enumerate(records) if record["kind"] == "codex.turn_completed"
    )
    records[completion_index:completion_index] = gates
    _renumber_times(records)

    report = evaluator.evaluate_same_turn_trajectory(records)

    assert "artifact_gate_order" in _finding_codes(report)


def test_progress_summary_is_allowlisted_for_recording() -> None:
    evaluator = _evaluation_module()
    records = deepcopy(_records())
    working = next(
        record
        for record in records
        if record["kind"] == "codex.progress" and record["data"]["phase"] == "working"  # type: ignore[index]
    )
    working["data"]["summary"] = "已执行 1 条命令。正在实现方块旋转"  # type: ignore[index]

    report = evaluator.evaluate_same_turn_trajectory(records)

    assert "progress_payload_not_allowlisted" not in _finding_codes(report)
    assert "progress_summary_unbounded" not in _finding_codes(report)


@pytest.mark.parametrize("summary", ["x" * 401, 123, "", "控制\x00符"])
def test_unbounded_or_non_text_progress_summary_is_a_finding(summary: object) -> None:
    evaluator = _evaluation_module()
    records = deepcopy(_records())
    working = next(
        record
        for record in records
        if record["kind"] == "codex.progress" and record["data"]["phase"] == "working"  # type: ignore[index]
    )
    working["data"]["summary"] = summary  # type: ignore[index]

    report = evaluator.evaluate_same_turn_trajectory(records)

    assert "progress_summary_unbounded" in _finding_codes(report)


def test_judge_view_excludes_the_progress_summary() -> None:
    """The judge keeps the counters-only view; free text cannot bias verdicts."""
    evaluator = _evaluation_module()
    records = deepcopy(_records())
    working = next(
        record
        for record in records
        if record["kind"] == "codex.progress" and record["data"]["phase"] == "working"  # type: ignore[index]
    )
    working["data"]["summary"] = "机密摘要哨兵"  # type: ignore[index]

    view = evaluator.build_judge_view(records)
    encoded = json.dumps(view, ensure_ascii=False)

    assert "机密摘要哨兵" not in encoded
    progress_events = [event for event in view["events"] if event["kind"] == "codex.progress"]
    assert progress_events
    assert all("summary" not in event["data"] for event in progress_events)


def test_progress_requires_started_zero_then_advancing_work() -> None:
    evaluator = _evaluation_module()
    records = deepcopy(_records())
    started = next(
        record
        for record in records
        if record["kind"] == "codex.progress" and record["data"]["phase"] == "started"  # type: ignore[index]
    )
    started["data"]["internal_activity"] = 1  # type: ignore[index]

    report = evaluator.evaluate_same_turn_trajectory(records)

    assert "progress_started_invalid" in _finding_codes(report)


def test_progress_cannot_be_omitted_from_the_acceptance_fixture() -> None:
    evaluator = _evaluation_module()
    records = [record for record in deepcopy(_records()) if record["kind"] != "codex.progress"]

    report = evaluator.evaluate_same_turn_trajectory(records)

    assert "progress_sequence_missing" in _finding_codes(report)


def test_working_progress_cannot_precede_the_started_milestone() -> None:
    evaluator = _evaluation_module()
    records = deepcopy(_records())
    working = next(
        record
        for record in records
        if record["kind"] == "codex.progress" and record["data"]["phase"] == "working"  # type: ignore[index]
    )
    records.remove(working)
    started_index = next(
        index
        for index, record in enumerate(records)
        if record["kind"] == "codex.progress" and record["data"]["phase"] == "started"  # type: ignore[index]
    )
    records.insert(started_index, working)
    _renumber_times(records)

    report = evaluator.evaluate_same_turn_trajectory(records)

    assert "progress_not_advancing" in _finding_codes(report)


def test_final_fastbrain_response_must_be_caused_by_the_run_handoff() -> None:
    evaluator = _evaluation_module()
    records = deepcopy(_records())
    final_response = next(record for record in records if record["event_ref"] == "e017")
    final_response["data"]["cause_ref"] = "e010"  # type: ignore[index]

    report = evaluator.evaluate_same_turn_trajectory(records)

    assert "final_response_missing" in _finding_codes(report)


def test_foreground_probe_must_happen_while_the_codex_turn_is_active() -> None:
    evaluator = _evaluation_module()
    records = deepcopy(_records())
    foreground = next(record for record in records if record["event_ref"] == "e011")
    foreground_reply = next(record for record in records if record["event_ref"] == "e012")
    records.remove(foreground)
    records.remove(foreground_reply)
    run_index = next(
        index
        for index, record in enumerate(records)
        if record["kind"] == "fast_brain.tool.codex_run"
    )
    records[run_index:run_index] = [foreground, foreground_reply]
    _renumber_times(records)

    report = evaluator.evaluate_same_turn_trajectory(records)

    assert "foreground_probe_not_in_flight" in _finding_codes(report)
