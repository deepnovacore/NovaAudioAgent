from __future__ import annotations

import copy
import json

import pytest

import nova_audio_agent.evals.codex_progress_recall as eval_module
from nova_audio_agent.evals.codex_progress_recall import (
    GATES,
    evaluate_codex_progress_recall,
    safe_filter_codex_progress_recall,
)

PASSING_BOARD_REFS = frozenset({"codex:2", "codex:3"})


def _record(ts: float, kind: str, payload: dict[str, object]) -> dict[str, object]:
    return {"ts": ts, "kind": kind, "payload": payload}


def passing_records() -> list[dict[str, object]]:
    return [
        _record(0.0, "codex.dispatch", {"delegate_id": "d-1"}),
        _record(
            1.0,
            "attention.decision",
            {
                "channel": "codex",
                "memory_ref": "codex:2",
                "speak": False,
                "selected": False,
            },
        ),
        _record(
            2.0,
            "attention.decision",
            {
                "channel": "codex",
                "memory_ref": "codex:3",
                "speak": True,
                "selected": True,
            },
        ),
        _record(2.5, "hostitem.injected", {"event_id": "suggestion:s-1"}),
        _record(
            3.0,
            "renderer.ack",
            {
                "kind": "playback_started",
                "utterance_id": "renderer-selected",
                "generation_epoch": 1,
                "t_render_ms": 12.0,
            },
        ),
        _record(
            3.0,
            "playback.attribution",
            {
                "target": "selected_progress",
                "memory_ref": "codex:3",
            },
        ),
        _record(
            4.0,
            "tool.admission",
            {"logical_name": "memory.recall", "outcome": "inline"},
        ),
        _record(
            4.1,
            "memory.recall",
            {
                "query_digest": "a" * 64,
                "scope": "recent",
                "state": "ok",
                "raw_scanned": 3,
                "searched_count": 3,
                "scan_truncated": False,
                "hit_count": 1,
                "hit_refs": ["codex:2"],
                "matches": {"lexical": 1, "recency_fallback": 0},
                "omitted": 0,
                "elapsed": 0.001,
            },
        ),
        _record(
            5.0,
            "renderer.ack",
            {
                "kind": "playback_started",
                "utterance_id": "renderer-recall",
                "generation_epoch": 2,
                "t_render_ms": 18.0,
            },
        ),
        _record(
            5.0,
            "playback.attribution",
            {"target": "memory_recall"},
        ),
    ]


def _gate(report: object, name: str) -> bool:
    gates = getattr(report, "gates")
    return next(gate.passed for gate in gates if gate.name == name)


def test_synthetic_take_ignores_desktop_only_memory_board_input() -> None:
    report = evaluate_codex_progress_recall(
        passing_records(), backend="synthetic_live", board_refs=frozenset()
    )

    assert report.passed is True
    assert report.harness_valid is True
    assert tuple(gate.name for gate in report.gates) == GATES
    assert all(gate.passed for gate in report.gates)
    assert report.timings_ms == {
        "decision_to_first_audio": 1000.0,
        "recall_to_first_audio": 1000.0,
    }


def test_orb_take_requires_all_decided_and_recalled_refs_in_memory_board() -> None:
    report = evaluate_codex_progress_recall(
        passing_records(), backend="orb_live", board_refs=PASSING_BOARD_REFS
    )

    assert tuple(gate.name for gate in report.gates) == (*GATES, "memory_board_evidence")
    assert report.passed is True
    assert report.harness_valid is True
    assert all(gate.passed for gate in report.gates)
    assert report.timings_ms == {
        "decision_to_first_audio": 1000.0,
        "recall_to_first_audio": 1000.0,
    }


@pytest.mark.parametrize("missing", ("codex:2", "codex:3"))
def test_orb_take_fails_when_memory_board_omits_required_ref(missing: str) -> None:
    report = evaluate_codex_progress_recall(
        passing_records(),
        backend="orb_live",
        board_refs=PASSING_BOARD_REFS - {missing},
    )

    assert _gate(report, "memory_board_evidence") is False
    assert report.harness_valid is True


def test_multiple_declined_progress_items_before_one_selection_are_a_valid_take() -> None:
    records = passing_records()
    records.insert(
        2,
        _record(
            1.5,
            "attention.decision",
            {
                "channel": "codex",
                "memory_ref": "codex:4",
                "speak": False,
                "selected": False,
            },
        ),
    )

    report = evaluate_codex_progress_recall(
        records, backend="orb_live", board_refs=PASSING_BOARD_REFS | {"codex:4"}
    )

    assert report.passed is True
    assert all(gate.passed for gate in report.gates)


@pytest.mark.parametrize(
    ("mutate", "failed_gate"),
    (
        (lambda records: records.pop(1), "declined_progress"),
        (
            lambda records: records.insert(
                7,
                _record(
                    4.05,
                    "tool.admission",
                    {"logical_name": "codex.status", "outcome": "sync"},
                ),
            ),
            "status_never_called",
        ),
        (
            lambda records: _recall_payload(records).__setitem__("hit_refs", ["codex:99"]),
            "silent_ref_recalled",
        ),
        (
            lambda records: records.insert(
                1, _record(0.5, "codex.dispatch", {"delegate_id": "d-2"})
            ),
            "single_delegate",
        ),
    ),
)
def test_named_mutations_fail_the_intended_gate(mutate: object, failed_gate: str) -> None:
    records = copy.deepcopy(passing_records())
    mutate(records)  # type: ignore[operator]

    report = evaluate_codex_progress_recall(
        records, backend="orb_live", board_refs=PASSING_BOARD_REFS
    )

    assert report.harness_valid is True
    assert report.passed is False
    assert _gate(report, failed_gate) is False


@pytest.mark.parametrize(
    ("remove_index", "failed_gate"),
    (
        (2, "selected_progress"),
        (3, "selected_host_injected_once"),
        (6, "recall_once"),
        (5, "timings_observed"),
    ),
)
def test_missing_evidence_fails_its_named_gate(remove_index: int, failed_gate: str) -> None:
    records = passing_records()
    records.pop(remove_index)

    report = evaluate_codex_progress_recall(records, backend="synthetic_live")

    assert report.harness_valid is True
    assert report.passed is False
    assert _gate(report, failed_gate) is False


def test_direct_progress_injection_fails_duplicate_authority_gate() -> None:
    records = passing_records()
    records.insert(4, _record(2.75, "hostitem.injected", {"event_id": "progress:d-1:working:2"}))

    report = evaluate_codex_progress_recall(
        records, backend="orb_live", board_refs=PASSING_BOARD_REFS
    )

    assert _gate(report, "no_duplicate_progress_authority") is False


def test_noncanonical_attention_verdict_cannot_count_as_progress_decision() -> None:
    records = passing_records()
    records.insert(
        3,
        _record(
            2.25,
            "attention.decision",
            {
                "channel": "codex",
                "memory_ref": "codex:4",
                "speak": True,
                "selected": False,
            },
        ),
    )

    report = evaluate_codex_progress_recall(
        records, backend="orb_live", board_refs=PASSING_BOARD_REFS
    )

    assert _gate(report, "selected_progress") is False


def test_dispatch_after_first_progress_decision_fails_single_delegate_gate() -> None:
    records = passing_records()
    dispatch = records.pop(0)
    dispatch["ts"] = 1.5
    records.insert(1, dispatch)

    report = evaluate_codex_progress_recall(
        records, backend="orb_live", board_refs=PASSING_BOARD_REFS
    )

    assert report.harness_valid is True
    assert _gate(report, "single_delegate") is False


def test_causal_order_uses_stream_position_when_timestamps_are_equal() -> None:
    records = passing_records()
    for record in records:
        record["ts"] = 1.0

    report = evaluate_codex_progress_recall(
        records, backend="orb_live", board_refs=PASSING_BOARD_REFS
    )

    assert report.passed is True

    dispatch = records.pop(0)
    records.insert(1, dispatch)
    late = evaluate_codex_progress_recall(records, backend="orb_live")
    assert _gate(late, "single_delegate") is False


def test_initial_delegated_codex_run_admission_passes_orb_single_delegate_gate() -> None:
    records = passing_records()
    records.insert(
        0,
        _record(0.0, "tool.admission", {"logical_name": "codex.run", "outcome": "delegated"}),
    )

    report = evaluate_codex_progress_recall(
        records, backend="orb_live", board_refs=PASSING_BOARD_REFS
    )

    assert report.harness_valid is True
    assert report.passed is True
    assert _gate(report, "single_delegate") is True


@pytest.mark.parametrize(
    "admissions",
    (
        ((0, "rejected"),),
        ((1, "delegated"),),
        ((0, "delegated"), (2, "delegated")),
    ),
)
def test_invalid_orb_codex_run_admission_fails_single_delegate_gate(
    admissions: tuple[tuple[int, str], ...],
) -> None:
    records = passing_records()
    for index, outcome in admissions:
        records.insert(
            index,
            _record(
                0.0 if index == 0 else 0.5,
                "tool.admission",
                {"logical_name": "codex.run", "outcome": outcome},
            ),
        )

    report = evaluate_codex_progress_recall(
        records, backend="orb_live", board_refs=PASSING_BOARD_REFS
    )

    assert report.harness_valid is True
    assert _gate(report, "single_delegate") is False


def test_synthetic_take_rejects_any_codex_run_admission() -> None:
    records = passing_records()
    records.insert(
        0,
        _record(0.0, "tool.admission", {"logical_name": "codex.run", "outcome": "delegated"}),
    )

    report = evaluate_codex_progress_recall(records, backend="synthetic_live")

    assert report.harness_valid is True
    assert _gate(report, "single_delegate") is False


@pytest.mark.parametrize(
    "terminal",
    (
        _record(3.5, "codex.handoff", {"delegate_id": "d-1", "outcome": "ok"}),
        _record(3.5, "hostitem.injected", {"event_id": "final:d-1"}),
    ),
)
def test_terminal_before_recall_admission_fails_recall_once_gate(
    terminal: dict[str, object],
) -> None:
    records = passing_records()
    records.insert(6, copy.deepcopy(terminal))

    report = evaluate_codex_progress_recall(records, backend="orb_live")

    assert report.harness_valid is True
    assert _gate(report, "recall_once") is False


def test_duplicate_selected_target_attribution_fails_exactly_once_gate() -> None:
    records = passing_records()
    records.insert(
        6,
        _record(
            3.5,
            "renderer.ack",
            {
                "kind": "playback_started",
                "utterance_id": "renderer-duplicate",
                "generation_epoch": 3,
            },
        ),
    )
    records.insert(
        7,
        _record(
            3.5,
            "playback.attribution",
            {
                "target": "selected_progress",
                "memory_ref": "codex:3",
            },
        ),
    )

    report = evaluate_codex_progress_recall(records, backend="orb_live")

    assert report.harness_valid is True
    assert _gate(report, "selected_host_injected_once") is False


def test_duplicate_recall_target_attribution_fails_timing_gate() -> None:
    records = passing_records()
    records.append(_record(5.5, "playback.attribution", {"target": "memory_recall"}))

    report = evaluate_codex_progress_recall(records, backend="orb_live")

    assert report.harness_valid is True
    assert _gate(report, "timings_observed") is False
    assert report.timings_ms["recall_to_first_audio"] is None


def _recall_payload(records: list[dict[str, object]]) -> dict[str, object]:
    payload = next(record["payload"] for record in records if record["kind"] == "memory.recall")
    assert isinstance(payload, dict)
    return payload


def _remove_attribution(records: list[dict[str, object]], target: str) -> None:
    records.pop(
        next(
            index
            for index, record in enumerate(records)
            if record["kind"] == "playback.attribution" and record["payload"]["target"] == target  # type: ignore[index]
        )
    )


def test_unattributed_playback_cannot_replace_selected_progress_audio() -> None:
    records = passing_records()
    _remove_attribution(records, "selected_progress")

    report = evaluate_codex_progress_recall(records, backend="orb_live")

    assert report.harness_valid is True
    assert _gate(report, "selected_host_injected_once") is False
    assert report.timings_ms["decision_to_first_audio"] is None


def test_unattributed_playback_cannot_replace_recall_audio() -> None:
    records = passing_records()
    _remove_attribution(records, "memory_recall")

    report = evaluate_codex_progress_recall(records, backend="orb_live")

    assert report.harness_valid is True
    assert _gate(report, "timings_observed") is False
    assert report.timings_ms["recall_to_first_audio"] is None


def test_extra_unattributed_playback_does_not_change_selected_exactly_once_gate() -> None:
    records = passing_records()
    records.insert(
        6,
        _record(
            3.5,
            "renderer.ack",
            {
                "kind": "playback_started",
                "utterance_id": "renderer-unrelated",
                "generation_epoch": 3,
            },
        ),
    )

    report = evaluate_codex_progress_recall(
        records, backend="orb_live", board_refs=PASSING_BOARD_REFS
    )

    assert report.harness_valid is True
    assert report.passed is True


def test_selected_attribution_with_wrong_memory_ref_fails_selected_host_gate() -> None:
    records = passing_records()
    attribution = next(
        record
        for record in records
        if record["kind"] == "playback.attribution"
        and record["payload"]["target"] == "selected_progress"  # type: ignore[index]
    )
    attribution["payload"]["memory_ref"] = "codex:4"  # type: ignore[index]

    report = evaluate_codex_progress_recall(records, backend="orb_live")

    assert report.harness_valid is True
    assert _gate(report, "selected_host_injected_once") is False
    assert report.timings_ms["decision_to_first_audio"] is None


@pytest.mark.parametrize(
    "mutate",
    (
        lambda records: records[1]["payload"].__setitem__(  # type: ignore[union-attr]
            "memory_ref", "watch:2"
        ),
        lambda records: _recall_payload(records).__setitem__("scope", "secret-scope"),
        lambda records: _recall_payload(records).__setitem__("state", "secret-state"),
        lambda records: _recall_payload(records).__setitem__("hit_count", 2),
        lambda records: _recall_payload(records).__setitem__(
            "matches", {"lexical": 0, "recency_fallback": 0}
        ),
        lambda records: _recall_payload(records).__setitem__("searched_count", 4),
        lambda records: _recall_payload(records).__setitem__("omitted", 3),
        lambda records: _recall_payload(records).__setitem__("hit_refs", ["codex:2"] * 2),
        lambda records: _recall_payload(records).update(
            hit_count=6,
            hit_refs=[f"codex:{index}" for index in range(2, 8)],
            matches={"lexical": 6, "recency_fallback": 0},
            searched_count=6,
            raw_scanned=6,
        ),
    ),
)
def test_adversarial_recall_envelopes_are_harness_invalid(mutate: object) -> None:
    records = passing_records()
    mutate(records)  # type: ignore[operator]

    report = evaluate_codex_progress_recall(records, backend="orb_live")

    assert report.harness_valid is False
    assert _gate(report, "telemetry_privacy") is False


@pytest.mark.parametrize(
    "payload",
    (
        {
            "query_digest": "a" * 64,
            "scope": "recent",
            "state": "empty",
            "raw_scanned": 3,
            "searched_count": 0,
            "scan_truncated": False,
            "hit_count": 0,
            "hit_refs": [],
            "matches": {"lexical": 0, "recency_fallback": 0},
            "omitted": 0,
            "elapsed": 0.001,
        },
        {
            "query_digest": "a" * 64,
            "scope": "any",
            "state": "error",
            "raw_scanned": 0,
            "searched_count": 0,
            "scan_truncated": False,
            "hit_count": 0,
            "hit_refs": [],
            "matches": {"lexical": 0, "recency_fallback": 0},
            "omitted": 0,
            "elapsed": 0.001,
        },
    ),
)
def test_production_empty_and_error_recall_shapes_remain_harness_valid(
    payload: dict[str, object],
) -> None:
    records = passing_records()
    _recall_payload(records).clear()
    _recall_payload(records).update(payload)

    report = evaluate_codex_progress_recall(records, backend="orb_live")

    assert report.harness_valid is True
    assert report.passed is False


@pytest.mark.parametrize(
    "changes",
    (
        {"state": "empty", "searched_count": 1},
        {"state": "empty", "hit_count": 1},
        {"state": "error", "raw_scanned": 1},
        {"state": "ok", "hit_count": 0, "hit_refs": []},
        {"matches": {"lexical": 1, "recency_fallback": 1}, "hit_count": 2},
    ),
)
def test_contradictory_recall_state_is_harness_invalid(changes: dict[str, object]) -> None:
    records = passing_records()
    _recall_payload(records).update(changes)

    report = evaluate_codex_progress_recall(records, backend="orb_live")

    assert report.harness_valid is False


def test_evaluator_rejects_total_and_relevant_record_overflow(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    total_limit = eval_module.MAX_EVIDENCE_RECORDS
    relevant_limit = eval_module.MAX_SAFE_EVENTS
    assert total_limit >= 20_000
    assert relevant_limit >= 5_000
    monkeypatch.setattr(eval_module, "MAX_EVIDENCE_RECORDS", 3)
    monkeypatch.setattr(eval_module, "MAX_SAFE_EVENTS", 2)
    total_overflow = [_record(float(index), "irrelevant", {}) for index in range(4)]
    relevant_overflow = [
        _record(
            float(index),
            "codex.handoff",
            {"delegate_id": f"d-{index}", "outcome": "ok"},
        )
        for index in range(3)
    ]

    assert evaluate_codex_progress_recall(total_overflow, backend="orb_live").harness_valid is False
    assert (
        evaluate_codex_progress_recall(relevant_overflow, backend="orb_live").harness_valid is False
    )


@pytest.mark.parametrize(
    "mutate",
    (
        lambda records: records[1]["payload"].__setitem__(  # type: ignore[union-attr]
            "memory_ref", "codex:" + "9" * 100_000
        ),
        lambda records: _recall_payload(records).update(
            raw_scanned=501,
            searched_count=501,
        ),
    ),
)
def test_evaluator_rejects_unbounded_memory_refs_and_recall_counts(mutate: object) -> None:
    records = passing_records()
    mutate(records)  # type: ignore[operator]

    report = evaluate_codex_progress_recall(records, backend="orb_live")

    assert report.harness_valid is False
    assert _gate(report, "telemetry_privacy") is False
    assert report.safe_events == ()


def test_evaluator_rejects_oversized_unsupported_record() -> None:
    records = passing_records()
    records.insert(
        0,
        _record(
            0.0,
            "unsupported.telemetry",
            {"blob": "x" * (2 * 1024 * 1024)},
        ),
    )

    report = evaluate_codex_progress_recall(records, backend="orb_live")

    assert report.harness_valid is False
    assert _gate(report, "telemetry_privacy") is False
    assert report.safe_events == ()


def test_evaluator_rejects_aggregate_unsupported_record_bytes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert eval_module.MAX_EVIDENCE_BYTES == 16 * 1024 * 1024
    monkeypatch.setattr(eval_module, "MAX_EVIDENCE_BYTES", 256)
    chunk_size = 128
    record_count = 3
    records = [
        _record(float(index), "unsupported.telemetry", {"blob": "x" * chunk_size})
        for index in range(record_count)
    ]

    report = evaluate_codex_progress_recall(records, backend="orb_live")

    assert report.harness_valid is False
    assert _gate(report, "telemetry_privacy") is False
    assert report.safe_events == ()


def test_evaluator_rejects_non_json_serializable_unsupported_payload() -> None:
    records = passing_records()
    records.insert(0, _record(0.0, "unsupported.telemetry", {"value": object()}))

    report = evaluate_codex_progress_recall(records, backend="orb_live")

    assert report.harness_valid is False
    assert _gate(report, "telemetry_privacy") is False
    assert report.safe_events == ()


@pytest.mark.parametrize("forbidden", ("reason", "arguments"))
def test_unapproved_relevant_payload_is_harness_invalid_privacy_failure(forbidden: str) -> None:
    records = passing_records()
    attention = records[1]["payload"]
    assert isinstance(attention, dict)
    attention[forbidden] = "NEVER-EXPOSE"

    report = evaluate_codex_progress_recall(records, backend="orb_live")

    assert report.harness_valid is False
    assert report.passed is False
    assert _gate(report, "telemetry_privacy") is False
    assert "NEVER-EXPOSE" not in json.dumps(report.safe_events, ensure_ascii=False)


def test_safe_filter_exposes_only_bounded_evidence_fields() -> None:
    records = passing_records()
    records.insert(
        1,
        _record(
            0.5,
            "provider.response_started",
            {"response_id": "NEVER-EXPOSE-PROVIDER-ID"},
        ),
    )
    records.insert(
        1,
        _record(
            0.25,
            "renderer.ack",
            {"kind": "clock_pong", "ping_id": "NEVER-EXPOSE-CLOCK", "t_render_ms": 1.0},
        ),
    )

    safe = safe_filter_codex_progress_recall(records)
    serialized = json.dumps(safe, ensure_ascii=False)

    assert "NEVER-EXPOSE" not in serialized
    assert "renderer-selected" not in serialized
    assert "suggestion:s-1" not in serialized
    assert "query_digest" not in serialized
    assert "/" not in serialized
    assert all(set(record) == {"ts", "kind", "payload"} for record in safe)
    assert [record["payload"] for record in safe if record["kind"] == "playback.attribution"] == [
        {"selected_progress": True},
        {"memory_recall": True},
    ]


@pytest.mark.parametrize(
    "payload",
    (
        {"target": "provider-secret"},
        {"target": "selected_progress"},
        {"target": "selected_progress", "memory_ref": "watch:2"},
        {"target": "memory_recall", "memory_ref": "codex:3"},
        {
            "target": "selected_progress",
            "memory_ref": "codex:3",
            "response_id": "NEVER-EXPOSE",
        },
        {
            "target": "selected_progress",
            "memory_ref": "codex:3",
            "utterance_id": "NEVER-EXPOSE",
        },
        {
            "target": "selected_progress",
            "memory_ref": "codex:3",
            "generation_epoch": 1,
        },
        {
            "target": "selected_progress",
            "memory_ref": "codex:3",
            "provider_id": "NEVER-EXPOSE",
        },
        {
            "target": "selected_progress",
            "memory_ref": "codex:3",
            "call_id": "NEVER-EXPOSE",
        },
    ),
)
def test_playback_attribution_envelope_is_strict_and_privacy_bounded(
    payload: dict[str, object],
) -> None:
    records = passing_records()
    attribution = next(
        record
        for record in records
        if record["kind"] == "playback.attribution"
        and record["payload"]["target"] == "selected_progress"  # type: ignore[index]
    )
    attribution["payload"] = payload

    report = evaluate_codex_progress_recall(records, backend="orb_live")

    assert report.harness_valid is False
    assert report.safe_events == ()


@pytest.mark.parametrize(
    "mutation",
    (
        lambda records: records[0].update(extra="NEVER-EXPOSE"),
        lambda records: records[0].update(ts=-1.0),
        lambda records: records[0].update(ts=float("nan")),
        lambda records: records[1].update(payload=[]),
        lambda records: records[1]["payload"].__setitem__("speak", 1),  # type: ignore[union-attr]
    ),
)
def test_malformed_evidence_is_harness_invalid_not_semantic_success(mutation: object) -> None:
    records = passing_records()
    mutation(records)  # type: ignore[operator]

    report = evaluate_codex_progress_recall(records, backend="synthetic_live")

    assert report.harness_valid is False
    assert report.passed is False
    assert _gate(report, "telemetry_privacy") is False


def test_latency_is_direction_only_with_no_slo_threshold() -> None:
    records = passing_records()
    records[4]["ts"] = 10_002.0
    records[5]["ts"] = 10_002.0
    records[6]["ts"] = 10_003.0
    records[7]["ts"] = 10_003.1
    records[8]["ts"] = 20_004.0
    records[9]["ts"] = 20_004.0

    report = evaluate_codex_progress_recall(records, backend="synthetic_live")

    assert _gate(report, "timings_observed") is True
    assert report.timings_ms == {
        "decision_to_first_audio": 10_000_000.0,
        "recall_to_first_audio": 10_001_000.0,
    }


def test_finite_timestamps_with_overflowing_milliseconds_are_unobserved_and_json_safe() -> None:
    records = passing_records()
    records[4]["ts"] = 1e308
    records[5]["ts"] = 1e308
    records[6]["ts"] = 1e308
    records[7]["ts"] = 1e308
    records[8]["ts"] = 1.1e308
    records[9]["ts"] = 1.1e308

    report = evaluate_codex_progress_recall(records, backend="synthetic_live")

    assert report.harness_valid is True
    assert _gate(report, "timings_observed") is False
    assert report.timings_ms == {
        "decision_to_first_audio": None,
        "recall_to_first_audio": None,
    }
    serialized = json.dumps(
        {"timings_ms": dict(report.timings_ms), "safe_events": report.safe_events},
        allow_nan=False,
    )
    assert "Infinity" not in serialized


@pytest.mark.parametrize("backend", ("deterministic", "live", ""))
def test_unknown_backend_is_harness_invalid(backend: str) -> None:
    with pytest.raises(ValueError, match="backend"):
        evaluate_codex_progress_recall(passing_records(), backend=backend)  # type: ignore[arg-type]
