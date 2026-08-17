from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest

from nova_audio_agent.realtime.volcengine.ark import (
    ArkResponseCompleted,
    ArkResponseStarted,
    ArkTextDelta,
)
from nova_audio_agent.realtime.volcengine.benchmark import ModelSummary, benchmark_cases
from scripts import benchmark_volcengine_llm as benchmark_cli
from scripts.benchmark_volcengine_llm import MODEL_CHOICES, build_parser, public_report, run_matrix


def test_parser_defaults_to_safe_mode_and_rejects_unlisted_model() -> None:
    parser = build_parser()
    args = parser.parse_args(["--models", "doubao-seed-2-0-pro-260215"])

    assert args.live is False
    assert args.runs == 2
    with pytest.raises(SystemExit):
        parser.parse_args(["--models", "arbitrary-model"])


@pytest.mark.parametrize("value", ["nan", "inf", "-inf"])
def test_parser_rejects_non_finite_timeout(value: str) -> None:
    parser = build_parser()

    with pytest.raises(SystemExit):
        parser.parse_args(["--models", "doubao-seed-2-0-pro-260215", "--timeout", value])


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
        provider_failures=0,
        protocol_failures=0,
        error_classes={},
        latency_ms={"function_call_ms": {"count": 2, "p50": 100.0, "p95": 120.0}},
        category_latency_ms={},
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
        provider_failures=0,
        protocol_failures=0,
        error_classes={},
        latency_ms={},
        category_latency_ms={},
    )
    candidate = ModelSummary(
        model="doubao-seed-2-1-turbo-260628",
        attempts=10,
        pass_rate=0.9,
        category_pass_rates={"selection": 0.9},
        severe_failures=0,
        provider_failures=0,
        protocol_failures=0,
        error_classes={},
        latency_ms={},
        category_latency_ms={},
    )

    report = public_report([candidate, baseline])

    by_model = {item["model"]: item for item in report["models"]}
    assert by_model[baseline.model]["passes_baseline_gate"] is True
    assert by_model[candidate.model]["passes_baseline_gate"] is False


@pytest.mark.asyncio
async def test_run_matrix_closes_injected_clients(monkeypatch: pytest.MonkeyPatch) -> None:
    class Client:
        def __init__(self) -> None:
            self.closed = False

        async def stream(self, **_kwargs: Any):
            yield ArkResponseStarted("response")
            yield ArkTextDelta("你好")
            yield ArkResponseCompleted("response")

        async def close(self) -> None:
            self.closed = True

    client = Client()
    case = next(case for case in benchmark_cases() if case.case_id == "small_talk_no_call")
    monkeypatch.setattr(benchmark_cli, "benchmark_cases", lambda: (case,))
    args = build_parser().parse_args(
        ["--live", "--runs", "1", "--models", "doubao-seed-2-0-pro-260215"]
    )

    summaries = await run_matrix(args, client_factory=lambda _model: client)

    assert summaries[0].pass_rate == 1.0
    assert client.closed is True


@pytest.mark.asyncio
async def test_run_matrix_attempts_all_client_closes_when_one_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Client:
        def __init__(self, *, close_fails: bool) -> None:
            self.close_fails = close_fails
            self.closed = False

        async def stream(self, **_kwargs: Any):
            yield ArkResponseStarted("response")
            yield ArkTextDelta("你好")
            yield ArkResponseCompleted("response")

        async def close(self) -> None:
            self.closed = True
            if self.close_fails:
                raise RuntimeError("secret cleanup detail")

    clients = {
        "doubao-seed-2-0-pro-260215": Client(close_fails=False),
        "doubao-seed-2-0-mini-260428": Client(close_fails=True),
    }
    case = next(case for case in benchmark_cases() if case.case_id == "small_talk_no_call")
    monkeypatch.setattr(benchmark_cli, "benchmark_cases", lambda: (case,))
    args = build_parser().parse_args(["--live", "--runs", "1", "--models", *clients])

    summaries = await run_matrix(args, client_factory=clients.__getitem__)

    assert all(client.closed for client in clients.values())
    by_model = {summary.model: summary for summary in summaries}
    assert by_model["doubao-seed-2-0-pro-260215"].provider_failures == 0
    assert by_model["doubao-seed-2-0-mini-260428"].provider_failures == 1
    assert by_model["doubao-seed-2-0-mini-260428"].error_classes == {"ClientCloseError": 1}


@pytest.mark.asyncio
async def test_main_returns_nonzero_after_reporting_protocol_failure(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    failed = ModelSummary(
        model="doubao-seed-2-0-pro-260215",
        attempts=1,
        pass_rate=0.0,
        category_pass_rates={"selection": 0.0},
        severe_failures=1,
        provider_failures=1,
        protocol_failures=0,
        error_classes={"ArkResponsesError": 1},
        latency_ms={},
        category_latency_ms={},
    )

    async def fake_run_matrix(_args: object) -> list[ModelSummary]:
        return [failed]

    monkeypatch.setattr(benchmark_cli, "run_matrix", fake_run_matrix)

    exit_code = await benchmark_cli._main(SimpleNamespace())

    assert exit_code == 1
    assert '"provider_failures": 1' in capsys.readouterr().out


@pytest.mark.asyncio
async def test_main_returns_nonzero_for_protocol_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    failed = ModelSummary(
        model="doubao-seed-2-0-pro-260215",
        attempts=1,
        pass_rate=0.0,
        category_pass_rates={"selection": 0.0},
        severe_failures=1,
        provider_failures=0,
        protocol_failures=1,
        error_classes={},
        latency_ms={},
        category_latency_ms={},
    )

    async def fake_run_matrix(_args: object) -> list[ModelSummary]:
        return [failed]

    monkeypatch.setattr(benchmark_cli, "run_matrix", fake_run_matrix)

    assert await benchmark_cli._main(SimpleNamespace()) == 1
