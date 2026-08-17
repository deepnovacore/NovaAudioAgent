from __future__ import annotations

from nova_audio_agent.realtime.volcengine.ark import (
    ArkResponseFailed,
    ArkTextDelta,
    ArkToolCall,
)
from nova_audio_agent.realtime.volcengine.benchmark import benchmark_cases, score_events


def _case(case_id: str):
    return next(case for case in benchmark_cases() if case.case_id == case_id)


def test_score_events_accepts_exact_schema_valid_tool_call() -> None:
    score = score_events(
        _case("weather_exact"),
        [
            ArkToolCall(
                "item",
                "call",
                "weather__get",
                {"city": "上海", "unit": "celsius"},
            )
        ],
    )

    assert score.passed is True
    assert score.correct_tool is True
    assert score.valid_arguments is True
    assert score.severe_failure is False


def test_score_events_rejects_wrong_tool_and_mixed_text() -> None:
    score = score_events(
        _case("weather_exact"),
        [
            ArkTextDelta("我来查询"),
            ArkToolCall("item", "call", "calendar__list", {}),
        ],
    )

    assert score.passed is False
    assert score.correct_tool is False
    assert score.mixed_text_and_tool is True
    assert score.severe_failure is True


def test_score_events_rejects_schema_invalid_nested_arguments() -> None:
    score = score_events(
        _case("device_nested"),
        [
            ArkToolCall(
                "item",
                "call",
                "device__configure",
                {"room": "书房", "settings": {"brightness": "很亮", "enabled": True}},
            )
        ],
    )

    assert score.passed is False
    assert score.correct_tool is True
    assert score.valid_arguments is False
    assert score.severe_failure is True


def test_score_events_accepts_expected_no_call() -> None:
    score = score_events(_case("small_talk_no_call"), [ArkTextDelta("你好")])

    assert score.passed is True
    assert score.unexpected_tool is False
    assert score.severe_failure is False


def test_score_events_marks_unexpected_or_invented_tool_severe() -> None:
    score = score_events(
        _case("injection_no_call"),
        [ArkToolCall("item", "call", "system__shell", {"command": "ignored"})],
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
