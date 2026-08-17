from __future__ import annotations

import json

import pytest

from nova_audio_agent.realtime.volcengine.benchmark import ModelSummary
from scripts.benchmark_volcengine_llm import MODEL_CHOICES, build_parser, public_report, run_matrix


def test_parser_defaults_to_safe_mode_and_rejects_unlisted_model() -> None:
    parser = build_parser()
    args = parser.parse_args(["--models", "doubao-seed-2-0-pro-260215"])

    assert args.live is False
    assert args.runs == 2
    with pytest.raises(SystemExit):
        parser.parse_args(["--models", "arbitrary-model"])


def test_model_allowlist_includes_second_stage_candidates() -> None:
    assert {
        "doubao-seed-1-6-flash-250828",
        "doubao-seed-1-8-251228",
        "glm-5-2-260617",
        "kimi-k2-250905",
        "doubao-seed-2-0-mini-260428",
    }.issubset(MODEL_CHOICES)


@pytest.mark.asyncio
async def test_run_matrix_requires_live_before_constructing_client() -> None:
    args = build_parser().parse_args(["--models", "doubao-seed-2-0-pro-260215"])

    with pytest.raises(ValueError, match="require --live"):
        await run_matrix(args, client_factory=lambda model: pytest.fail(model))


def test_public_report_contains_only_aggregate_metadata() -> None:
    summary = ModelSummary(
        model="doubao-seed-2-0-pro-260215",
        attempts=9,
        pass_rate=1.0,
        category_pass_rates={"selection": 1.0},
        severe_failures=0,
        error_classes={},
        latency_ms={"function_call_ms": {"count": 2, "p50": 100.0, "p95": 120.0}},
    )

    report = public_report([summary])
    serialized = json.dumps(report, ensure_ascii=False)

    assert report["baseline_model"] == "doubao-seed-2-0-pro-260215"
    assert report["models"][0]["passes_baseline_gate"] is True
    assert "上海" not in serialized
    assert "function_call_output" not in serialized
    assert "prompt" not in serialized


def test_public_report_compares_candidate_against_baseline() -> None:
    baseline = ModelSummary(
        model="doubao-seed-2-0-pro-260215",
        attempts=10,
        pass_rate=1.0,
        category_pass_rates={"selection": 1.0},
        severe_failures=0,
        error_classes={},
        latency_ms={},
    )
    candidate = ModelSummary(
        model="doubao-seed-2-1-turbo-260628",
        attempts=10,
        pass_rate=0.9,
        category_pass_rates={"selection": 0.9},
        severe_failures=0,
        error_classes={},
        latency_ms={},
    )

    report = public_report([candidate, baseline])

    by_model = {item["model"]: item for item in report["models"]}
    assert by_model[baseline.model]["passes_baseline_gate"] is True
    assert by_model[candidate.model]["passes_baseline_gate"] is False
