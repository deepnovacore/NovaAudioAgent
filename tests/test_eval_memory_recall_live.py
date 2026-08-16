from __future__ import annotations

from scripts.eval_memory_recall import CaseResult, evaluate_results


def _recall_result(**overrides: object) -> CaseResult:
    values: dict[str, object] = {
        "case": "recall",
        "tool_calls": ("memory__recall",),
        "accepted": True,
        "inline_fulfilled": True,
        "delegate_id": None,
        "sync_result": False,
        "hit_refs": ("watch:1",),
        "answer": "刚才看到的是蓝色水杯，编号七十二。",
        "first_audio_ms": 820.0,
        "first_audio_before_transcript_final": False,
        "trigger_ms": 210.0,
        "proposal_before_transcript_final": True,
        "recall_ms": 0.4,
        "memory_unchanged": True,
        "injected_kinds": ("tool_output",),
    }
    values.update(overrides)
    return CaseResult(**values)  # type: ignore[arg-type]


def _negative_result(**overrides: object) -> CaseResult:
    values: dict[str, object] = {
        "case": "negative",
        "tool_calls": (),
        "accepted": None,
        "inline_fulfilled": None,
        "delegate_id": None,
        "sync_result": None,
        "hit_refs": (),
        "answer": "你好，很高兴见到你。",
        "first_audio_ms": -40.0,
        "first_audio_before_transcript_final": True,
        "trigger_ms": None,
        "proposal_before_transcript_final": None,
        "recall_ms": None,
        "memory_unchanged": True,
        "injected_kinds": (),
    }
    values.update(overrides)
    return CaseResult(**values)  # type: ignore[arg-type]


def test_live_evaluator_accepts_grounded_recall_and_zero_false_positive() -> None:
    report = evaluate_results(_recall_result(), _negative_result())

    assert report["passed"] is True
    assert all(gate["passed"] for gate in report["gates"])


def test_live_evaluator_rejects_missing_recall_trigger() -> None:
    report = evaluate_results(_recall_result(tool_calls=()), _negative_result())

    assert report["passed"] is False
    assert (
        next(gate for gate in report["gates"] if gate["name"] == "recall_trigger")["passed"]
        is False
    )


def test_live_evaluator_rejects_ungrounded_answer() -> None:
    report = evaluate_results(_recall_result(answer="我看到了一个水杯。"), _negative_result())

    assert report["passed"] is False
    assert (
        next(gate for gate in report["gates"] if gate["name"] == "grounded_answer")["passed"]
        is False
    )


def test_live_evaluator_rejects_non_history_false_positive() -> None:
    report = evaluate_results(
        _recall_result(),
        _negative_result(tool_calls=("memory__recall",)),
    )

    assert report["passed"] is False
    assert (
        next(gate for gate in report["gates"] if gate["name"] == "negative_control")["passed"]
        is False
    )


def test_live_evaluator_rejects_inconsistent_negative_event_order_and_clock() -> None:
    report = evaluate_results(
        _recall_result(),
        _negative_result(
            first_audio_ms=12.0,
            first_audio_before_transcript_final=True,
        ),
    )

    assert report["passed"] is False
    assert (
        next(gate for gate in report["gates"] if gate["name"] == "negative_timing_consistent")[
            "passed"
        ]
        is False
    )


def test_live_evaluator_accepts_non_speculative_negative_when_order_is_consistent() -> None:
    report = evaluate_results(
        _recall_result(),
        _negative_result(
            first_audio_ms=12.0,
            first_audio_before_transcript_final=False,
        ),
    )

    assert report["passed"] is True


def test_live_evaluator_requires_observed_recall_proposal_order() -> None:
    report = evaluate_results(
        _recall_result(proposal_before_transcript_final=None),
        _negative_result(),
    )

    assert report["passed"] is False
    assert (
        next(gate for gate in report["gates"] if gate["name"] == "proposal_order_observed")[
            "passed"
        ]
        is False
    )


def test_live_evaluator_requires_inline_side_effect_free_fulfillment() -> None:
    report = evaluate_results(
        _recall_result(delegate_id="d-1", memory_unchanged=False),
        _negative_result(),
    )

    assert report["passed"] is False
    assert (
        next(gate for gate in report["gates"] if gate["name"] == "inline_contract")["passed"]
        is False
    )
