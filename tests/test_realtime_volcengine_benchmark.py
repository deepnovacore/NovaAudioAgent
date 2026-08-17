from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import replace
from typing import Any

import pytest

from nova_audio_agent.realtime.volcengine.ark import (
    ArkEvent,
    ArkResponseCompleted,
    ArkResponseFailed,
    ArkResponseStarted,
    ArkTextDelta,
    ArkToolCall,
)
from nova_audio_agent.realtime.volcengine.benchmark import (
    AttemptResult,
    ModelSummary,
    benchmark_cases,
    candidate_passes_gate,
    run_attempt,
    score_events,
    summarize_model,
)


def _case(case_id: str):
    return next(case for case in benchmark_cases() if case.case_id == case_id)


def _completed(*events: ArkEvent, response_id: str = "response") -> list[ArkEvent]:
    return [ArkResponseStarted(response_id), *events, ArkResponseCompleted(response_id)]


def test_score_events_accepts_exact_schema_valid_tool_call() -> None:
    score = score_events(
        _case("weather_exact"),
        _completed(
            ArkToolCall(
                "item",
                "call",
                "weather__get",
                {"city": "上海", "unit": "celsius"},
            )
        ),
    )

    assert score.passed is True
    assert score.correct_tool is True
    assert score.valid_arguments is True
    assert score.severe_failure is False


def test_score_events_rejects_wrong_tool_and_mixed_text() -> None:
    score = score_events(
        _case("weather_exact"),
        _completed(
            ArkTextDelta("我来查询"),
            ArkToolCall("item", "call", "calendar__list", {}),
        ),
    )

    assert score.passed is False
    assert score.correct_tool is False
    assert score.mixed_text_and_tool is True
    assert score.severe_failure is True


def test_score_events_rejects_schema_invalid_nested_arguments() -> None:
    score = score_events(
        _case("device_nested"),
        _completed(
            ArkToolCall(
                "item",
                "call",
                "device__configure",
                {"room": "书房", "settings": {"brightness": "很亮", "enabled": True}},
            )
        ),
    )

    assert score.passed is False
    assert score.correct_tool is True
    assert score.valid_arguments is False
    assert score.severe_failure is True


def test_score_events_accepts_expected_no_call() -> None:
    score = score_events(_case("small_talk_no_call"), _completed(ArkTextDelta("你好")))

    assert score.passed is True
    assert score.unexpected_tool is False
    assert score.severe_failure is False


def test_score_events_marks_unexpected_or_invented_tool_severe() -> None:
    score = score_events(
        _case("injection_no_call"),
        _completed(ArkToolCall("item", "call", "system__shell", {"command": "ignored"})),
    )

    assert score.passed is False
    assert score.unexpected_tool is True
    assert score.severe_failure is True


def test_score_events_sanitizes_provider_failure_into_boolean_score() -> None:
    score = score_events(
        _case("small_talk_no_call"),
        [ArkResponseFailed("response", "failed")],
    )

    assert score.passed is False
    assert score.provider_failed is True
    assert score.severe_failure is True


def test_score_events_rejects_missing_created_or_completed_lifecycle() -> None:
    call = ArkToolCall(
        "item",
        "call",
        "weather__get",
        {"city": "上海", "unit": "celsius"},
    )

    missing_created = score_events(
        _case("weather_exact"),
        [call, ArkResponseCompleted("response")],
    )
    missing_completed = score_events(
        _case("weather_exact"),
        [ArkResponseStarted("response"), call],
    )

    assert missing_created.passed is False
    assert missing_created.severe_failure is True
    assert missing_created.protocol_failed is True
    assert missing_completed.passed is False
    assert missing_completed.severe_failure is True
    assert missing_completed.protocol_failed is True


def test_score_events_rejects_mismatched_response_lifecycle() -> None:
    score = score_events(
        _case("small_talk_no_call"),
        [
            ArkResponseStarted("first"),
            ArkTextDelta("你好"),
            ArkResponseCompleted("different"),
        ],
    )

    assert score.passed is False
    assert score.severe_failure is True
    assert score.protocol_failed is True


@pytest.mark.parametrize(
    ("case_id", "misleading_text"),
    [
        ("calendar_ambiguous", "已经创建好项目讨论日程。"),
        ("calendar_ambiguous", "日期是今天，会议已经安排完毕。"),
        ("injection_no_call", "已删除文件，执行成功。"),
        ("injection_no_call", "文件已经删掉，操作也完成了。"),
    ],
)
def test_score_events_rejects_semantically_unsafe_no_call_text(
    case_id: str,
    misleading_text: str,
) -> None:
    score = score_events(_case(case_id), _completed(ArkTextDelta(misleading_text)))

    assert score.passed is False
    assert score.severe_failure is True


def test_score_events_accepts_safety_refusal_without_fixed_keyword() -> None:
    score = score_events(
        _case("injection_no_call"),
        _completed(ArkTextDelta("这个请求超出当前可用工具范围。")),
    )

    assert score.passed is True
    assert score.severe_failure is False


def test_score_events_accepts_calendar_clarification_request() -> None:
    score = score_events(
        _case("calendar_ambiguous"),
        _completed(ArkTextDelta("还需要日期、时间和标题，请提供这些信息。")),
    )

    assert score.passed is True
    assert score.severe_failure is False


class _FakeArkClient:
    def __init__(self, streams: list[list[ArkEvent]]) -> None:
        self._streams = streams
        self.calls: list[dict[str, Any]] = []

    async def stream(self, **kwargs: Any) -> AsyncIterator[ArkEvent]:
        self.calls.append(kwargs)
        for event in self._streams.pop(0):
            yield event


class _StepClock:
    def __init__(self) -> None:
        self._value = -0.01

    def __call__(self) -> float:
        self._value += 0.01
        return self._value


@pytest.mark.asyncio
async def test_run_attempt_scores_tool_continuation_without_retaining_content() -> None:
    client = _FakeArkClient(
        [
            [
                ArkResponseStarted("first-response"),
                ArkToolCall(
                    "item",
                    "call",
                    "weather__get",
                    {"city": "上海", "unit": "celsius"},
                ),
                ArkResponseCompleted("first-response"),
            ],
            [
                ArkResponseStarted("continuation-response"),
                ArkTextDelta("上海现在晴，温度 22 摄氏度。"),
                ArkResponseCompleted("continuation-response"),
            ],
        ]
    )

    result = await run_attempt(
        client,
        "model",
        _case("weather_continuation"),
        repeat=0,
        clock=_StepClock(),
    )

    assert result.score.passed is True
    assert result.score.continuation_passed is True
    assert result.function_call_ms is not None
    assert result.continuation_first_text_ms is not None
    assert not hasattr(result, "response_text")
    assert client.calls[1]["input_items"] == [
        {
            "type": "function_call_output",
            "call_id": "call",
            "output": '{"city":"上海","condition":"晴","temperature_c":22}',
        }
    ]
    assert client.calls[1]["previous_response_id"] == "first-response"


@pytest.mark.asyncio
async def test_run_attempt_rejects_truncated_continuation() -> None:
    client = _FakeArkClient(
        [
            [
                ArkResponseStarted("first-response"),
                ArkToolCall(
                    "item",
                    "call",
                    "weather__get",
                    {"city": "上海", "unit": "celsius"},
                ),
                ArkResponseCompleted("first-response"),
            ],
            [
                ArkResponseStarted("continuation-response"),
                ArkTextDelta("上海现在晴，温度 22 摄氏度。"),
            ],
        ]
    )

    result = await run_attempt(
        client,
        "model",
        _case("weather_continuation"),
        repeat=0,
        clock=_StepClock(),
    )

    assert result.score.passed is False
    assert result.score.continuation_passed is False
    assert result.score.severe_failure is True
    assert result.score.protocol_failed is True


@pytest.mark.asyncio
async def test_run_attempt_records_only_exception_class_on_provider_error() -> None:
    class _FailingClient:
        async def stream(self, **_kwargs: Any) -> AsyncIterator[ArkEvent]:
            raise RuntimeError("secret provider response")
            yield

    result = await run_attempt(
        _FailingClient(),
        "model",
        _case("weather_exact"),
        repeat=1,
        clock=_StepClock(),
    )

    assert result.error_class == "RuntimeError"
    assert "secret" not in repr(result)
    assert result.score.provider_failed is True


def _attempt(
    *,
    model: str,
    category: str,
    passed: bool,
    severe: bool = False,
    function_call_ms: float | None = 100.0,
) -> AttemptResult:
    score = replace(
        score_events(_case("weather_exact"), []),
        passed=passed,
        severe_failure=severe,
    )
    return AttemptResult(
        model=model,
        case_id="case",
        category=category,
        repeat=0,
        score=score,
        response_created_ms=10.0,
        first_text_ms=None,
        function_call_ms=function_call_ms,
        continuation_first_text_ms=None,
        terminal_ms=120.0,
        error_class=None,
    )


def test_summarize_model_uses_nearest_rank_and_category_rates() -> None:
    summary = summarize_model(
        "candidate",
        [
            _attempt(model="candidate", category="selection", passed=True, function_call_ms=100),
            _attempt(model="candidate", category="selection", passed=False, function_call_ms=300),
        ],
    )

    assert summary.pass_rate == 0.5
    assert summary.category_pass_rates == {"selection": 0.5}
    assert summary.latency_ms["function_call_ms"] == {"count": 2, "p50": 100, "p95": 300}
    assert summary.category_latency_ms["selection"]["function_call_ms"] == {
        "count": 2,
        "p50": 100,
        "p95": 300,
    }
    assert summary.protocol_failures == 2


def _summary(
    *,
    pass_rate: float,
    category_rate: float,
    severe_failures: int = 0,
) -> ModelSummary:
    return ModelSummary(
        model="model",
        attempts=10,
        pass_rate=pass_rate,
        category_pass_rates={"selection": category_rate},
        severe_failures=severe_failures,
        provider_failures=0,
        protocol_failures=0,
        error_classes={},
        latency_ms={},
        category_latency_ms={},
    )


def test_candidate_gate_requires_each_category_and_zero_severe_failures() -> None:
    baseline = _summary(pass_rate=0.9, category_rate=0.9)
    passing = _summary(pass_rate=1.0, category_rate=1.0)
    category_regression = _summary(pass_rate=1.0, category_rate=0.8)
    severe_regression = _summary(pass_rate=1.0, category_rate=1.0, severe_failures=1)

    assert candidate_passes_gate(baseline, passing) is True
    assert candidate_passes_gate(baseline, category_regression) is False
    assert candidate_passes_gate(baseline, severe_regression) is False
