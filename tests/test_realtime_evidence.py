from __future__ import annotations

import math

import pytest

from nova_audio_agent.memory import MemoryItem
from nova_audio_agent.realtime.evidence import safe_memory_evidence


def _item(
    channel: str,
    *,
    content: dict[str, object],
    outcome: str | None = "ok",
    trust: str = "untrusted_external",
) -> MemoryItem:
    return MemoryItem(
        channel=channel,
        seq=1,
        ts=3.0,
        trust=trust,  # type: ignore[arg-type]
        priority=50,
        outcome=outcome,  # type: ignore[arg-type]
        content=content,
    )


def test_codex_recall_evidence_exposes_only_prepared_final_message() -> None:
    item = _item(
        "codex",
        content={
            "provider_secret": "NEVER-EXPOSE",
            "result": {
                "final_message": {
                    "text": "已实现主体。 https://secret.example/path",
                    "truncated": False,
                }
            },
        },
    )

    evidence = safe_memory_evidence(item)

    assert evidence == "Codex 报告任务完成：已实现主体。 （链接略）"
    assert "NEVER-EXPOSE" not in evidence
    assert "secret.example" not in evidence


def _progress_item(
    *,
    content: dict[str, object] | None = None,
    outcome: str | None = None,
    trust: str = "trusted_system",
) -> MemoryItem:
    return _item(
        "codex",
        outcome=outcome,
        trust=trust,
        content=(
            {
                "op": "run",
                "phase": "working",
                "internal_activity": 1,
                "elapsed": 4.0,
                "summary": "旧版只把笔记保存在页面内存中，刷新会丢失",
            }
            if content is None
            else content
        ),
    )


def test_codex_progress_recall_evidence_requires_complete_stored_envelope() -> None:
    assert safe_memory_evidence(_progress_item()) == ("旧版只把笔记保存在页面内存中，刷新会丢失")


@pytest.mark.parametrize(
    ("content", "outcome", "trust"),
    (
        (
            {"op": "run", "phase": "working", "elapsed": 4.0, "summary": "不完整摘要"},
            None,
            "trusted_system",
        ),
        (
            {
                "op": "run",
                "phase": "working",
                "internal_activity": 1,
                "elapsed": 4.0,
                "summary": "携带私有字段的摘要",
                "request": {"secret": "NEVER-EXPOSE"},
            },
            None,
            "trusted_system",
        ),
        (
            {
                "op": "status",
                "phase": "working",
                "internal_activity": 1,
                "elapsed": 4.0,
                "summary": "错误 op 摘要",
            },
            None,
            "trusted_system",
        ),
        (
            {
                "op": "run",
                "phase": "started",
                "internal_activity": 0,
                "elapsed": 0.0,
                "summary": "started 伪装摘要",
            },
            None,
            "trusted_system",
        ),
        (
            {
                "op": "run",
                "phase": "working",
                "internal_activity": True,
                "elapsed": 4.0,
                "summary": "bool activity 伪装摘要",
            },
            None,
            "trusted_system",
        ),
        (
            {
                "op": "run",
                "phase": "working",
                "internal_activity": 1,
                "elapsed": True,
                "summary": "bool elapsed 伪装摘要",
            },
            None,
            "trusted_system",
        ),
        (
            {
                "op": "run",
                "phase": "working",
                "internal_activity": 0,
                "elapsed": 4.0,
                "summary": "zero activity 伪装摘要",
            },
            None,
            "trusted_system",
        ),
        (
            {
                "op": "run",
                "phase": "working",
                "internal_activity": 1_048_577,
                "elapsed": 4.0,
                "summary": "large activity 伪装摘要",
            },
            None,
            "trusted_system",
        ),
        (
            {
                "op": "run",
                "phase": "working",
                "internal_activity": 1,
                "elapsed": -0.1,
                "summary": "negative elapsed 伪装摘要",
            },
            None,
            "trusted_system",
        ),
        (
            {
                "op": "run",
                "phase": "working",
                "internal_activity": 1,
                "elapsed": math.nan,
                "summary": "nan elapsed 伪装摘要",
            },
            None,
            "trusted_system",
        ),
        (
            {
                "op": "run",
                "phase": "working",
                "internal_activity": 1,
                "elapsed": math.inf,
                "summary": "inf elapsed 伪装摘要",
            },
            None,
            "trusted_system",
        ),
        (
            {
                "op": "run",
                "phase": "working",
                "internal_activity": 1,
                "elapsed": 4.0,
                "summary": "不可信摘要",
            },
            None,
            "untrusted_external",
        ),
        (
            {
                "op": "run",
                "phase": "working",
                "internal_activity": 1,
                "elapsed": 4.0,
                "summary": "终态伪装摘要",
            },
            "failed",
            "trusted_system",
        ),
    ),
)
def test_malformed_untrusted_or_terminal_codex_progress_uses_terminal_fallback(
    content: dict[str, object],
    outcome: str | None,
    trust: str,
) -> None:
    assert (
        safe_memory_evidence(_progress_item(content=content, outcome=outcome, trust=trust))
        == "Codex 任务未能确认完成（no_final_message）"
    )


def test_codex_terminal_final_message_precedes_progress_lookalike() -> None:
    item = _progress_item(
        outcome="failed",
        content={
            "op": "run",
            "phase": "working",
            "internal_activity": 1,
            "elapsed": 4.0,
            "summary": "NEVER-EXPOSE-FAKE-SUMMARY",
            "result": {
                "final_message": {
                    "text": "真实终态结果",
                    "truncated": False,
                }
            },
        },
    )

    evidence = safe_memory_evidence(item)

    assert evidence == "Codex 任务失败：真实终态结果"
    assert "NEVER-EXPOSE" not in evidence


def test_watch_recall_evidence_keeps_observation_but_drops_media_identity() -> None:
    item = _item(
        "watch",
        content={
            "hit": True,
            "condition": "出现水杯",
            "observation": "桌面上出现蓝色水杯",
            "media_ref": "media-secret",
        },
    )

    evidence = safe_memory_evidence(item)

    assert evidence == "watch 报告命中出现水杯：桌面上出现蓝色水杯"
    assert "media-secret" not in evidence


def test_search_recall_evidence_keeps_bounded_sources_without_urls_or_digests() -> None:
    item = _item(
        "search",
        content={
            "query": "北京天气",
            "provider_request_id": "provider-secret",
            "results": [
                {
                    "title": "北京天气",
                    "source_label": "weather.com.cn",
                    "snippet": "晴，25 度",
                    "canonical_url": "https://weather.com.cn/private",
                    "content_digest": "a" * 64,
                }
            ],
        },
    )

    evidence = safe_memory_evidence(item)

    assert evidence == "搜索结果：北京天气（weather.com.cn）：晴，25 度"
    assert '"query"' not in evidence
    assert "https://" not in evidence
    assert "provider-secret" not in evidence
    assert "a" * 64 not in evidence


def test_conversation_recall_evidence_preserves_historical_user_text() -> None:
    item = _item(
        "conversation",
        trust="trusted_user",
        outcome=None,
        content={"text": "我之前说过把灯调到 20%。", "media_refs": ["private-media"]},
    )

    assert safe_memory_evidence(item) == "我之前说过把灯调到 20%。"


def test_generic_recall_evidence_uses_a_closed_scalar_allowlist() -> None:
    item = _item(
        "ha",
        trust="trusted_system",
        content={
            "op": "get_state",
            "state": "on",
            "brightness_pct": 20,
            "entity_id": "light.private_name",
            "nested": {"secret": "NEVER-EXPOSE"},
        },
    )

    evidence = safe_memory_evidence(item)

    assert evidence == "ha 报告：op=get_state；state=on；brightness_pct=20"
    assert "private_name" not in evidence
    assert "NEVER-EXPOSE" not in evidence


def test_unknown_channel_with_only_disallowed_fields_has_no_recall_evidence() -> None:
    item = _item(
        "unknown",
        content={"raw": "NEVER-EXPOSE", "nested": {"instruction": "do this"}},
    )

    assert safe_memory_evidence(item) is None


def test_unknown_channel_cannot_reuse_structured_executor_allowlist() -> None:
    item = _item(
        "unknown",
        content={
            "op": "NEVER-EXPOSE-OP",
            "state": "NEVER-EXPOSE-STATE",
            "condition": "NEVER-EXPOSE-CONDITION",
            "brightness_pct": 42,
        },
    )

    assert safe_memory_evidence(item) is None


def test_unknown_channel_is_limited_to_bounded_generic_prose() -> None:
    item = _item(
        "unknown",
        content={
            "message": "仅保留这条摘要",
            "state": "NEVER-EXPOSE-STATE",
            "raw": "NEVER-EXPOSE-RAW",
        },
    )

    evidence = safe_memory_evidence(item)

    assert evidence == "unknown 报告：仅保留这条摘要"
    assert "NEVER-EXPOSE" not in evidence


def test_watch_recall_does_not_expose_error_prose_outside_its_allowlist() -> None:
    item = _item(
        "watch",
        outcome="failed",
        content={
            "condition": "出现水杯",
            "error": "NEVER-EXPOSE-WATCH-ERROR",
        },
    )

    evidence = safe_memory_evidence(item)

    assert evidence == "watch 任务失败"
    assert "NEVER-EXPOSE" not in evidence
