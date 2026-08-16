from __future__ import annotations

import json
from typing import get_args

import pytest

import nova_audio_agent.realtime.recall as recall_module
from nova_audio_agent.memory import (
    CONVERSATION_CHANNEL,
    USER_PRIORITY,
    HandoffPolicy,
    Memory,
)
from nova_audio_agent.realtime.recall import (
    RecallOriginError,
    RecallHit,
    RecallView,
    compile_memory_recall,
    encode_memory_recall,
)


def _policy(channel: str) -> HandoffPolicy:
    return HandoffPolicy(
        channel=channel,
        priority=50,
        wake="none",
        typical_latency=0.0,
        compress_watermark=40,
    )


def _memory(*channels: str) -> Memory:
    return Memory(policies=tuple(_policy(channel) for channel in channels))


def _append(
    memory: Memory,
    channel: str,
    *,
    ts: float,
    content: dict[str, object],
    priority: int = 50,
) -> str:
    return memory.append(
        channel,
        ts=ts,
        trust="untrusted_external",
        priority=priority,
        outcome="ok",
        content=content,
    ).ref


def test_recall_excludes_the_current_user_question_from_candidates() -> None:
    memory = _memory("watch")
    watch_ref = _append(
        memory,
        "watch",
        ts=3.0,
        content={
            "hit": True,
            "condition": "出现水杯",
            "observation": "桌面上出现蓝色水杯",
        },
    )
    question = memory.append(
        CONVERSATION_CHANNEL,
        ts=5.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "刚才摄像头看到了什么"},
    )

    view = compile_memory_recall(
        memory,
        query="刚才摄像头看到了什么",
        scope="recent",
        before_ref=question.ref,
    )

    assert [hit.ref for hit in view.hits] == [watch_ref]
    assert all(hit.ref != question.ref for hit in view.hits)
    assert view.hits[0].match == "recency_fallback"


def test_recent_scans_only_latest_five_raw_items_per_channel_and_ignores_summary() -> None:
    memory = _memory("ha")
    for index in range(1, 8):
        _append(memory, "ha", ts=float(index), content={"state": f"value-{index}"})
    memory.channels["ha"].summary = "NEVER-RETURN-SUMMARY oldest target"
    question = memory.append(
        CONVERSATION_CHANNEL,
        ts=9.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "oldest target"},
    )

    view = compile_memory_recall(
        memory,
        query="oldest target",
        scope="recent",
        before_ref=question.ref,
    )

    assert view.searched_count == 5
    assert {hit.ref for hit in view.hits} == {f"ha:{seq}" for seq in range(3, 8)}
    assert all("NEVER-RETURN-SUMMARY" not in hit.evidence for hit in view.hits)


def test_recent_conversation_tail_is_selected_after_applying_origin_cutoff() -> None:
    memory = _memory()
    for index in range(1, 8):
        memory.append(
            CONVERSATION_CHANNEL,
            ts=float(index),
            trust="trusted_user",
            priority=USER_PRIORITY,
            content={"text": f"historical-{index}"},
        )
    question = memory.append(
        CONVERSATION_CHANNEL,
        ts=8.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "unrelated question"},
    )

    view = compile_memory_recall(
        memory,
        query="nothing matches",
        scope="recent",
        before_ref=question.ref,
    )

    assert view.searched_count == 5
    assert [hit.ref for hit in view.hits] == [
        "conversation:7",
        "conversation:6",
        "conversation:5",
        "conversation:4",
        "conversation:3",
    ]


def test_any_caps_inspection_at_500_newest_raw_candidates() -> None:
    memory = _memory("ha")
    oldest_ref = _append(memory, "ha", ts=1.0, content={"state": "oldest-target"})
    for index in range(2, 502):
        _append(memory, "ha", ts=float(index), content={"state": f"value-{index}"})
    question = memory.append(
        CONVERSATION_CHANNEL,
        ts=600.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "oldest target"},
    )

    view = compile_memory_recall(
        memory,
        query="oldest target",
        scope="any",
        before_ref=question.ref,
    )

    assert view.searched_count == 500
    assert view.scan_truncated is True
    assert oldest_ref not in {hit.ref for hit in view.hits}


def test_any_uses_channel_sequence_as_recency_when_timestamps_tie() -> None:
    memory = _memory("ha")
    oldest_ref = _append(memory, "ha", ts=1.0, content={"state": "oldest-target"})
    for index in range(2, 502):
        _append(memory, "ha", ts=1.0, content={"state": f"value-{index}"})
    question = memory.append(
        CONVERSATION_CHANNEL,
        ts=2.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "oldest target"},
    )

    view = compile_memory_recall(
        memory,
        query="oldest target",
        scope="any",
        before_ref=question.ref,
    )

    assert view.scan_truncated is True
    assert oldest_ref not in {hit.ref for hit in view.hits}


def test_cjk_bigrams_and_ascii_tokens_rank_relevant_codex_result_first() -> None:
    memory = _memory("codex", "watch")
    codex_ref = _append(
        memory,
        "codex",
        ts=2.0,
        content={
            "result": {
                "final_message": {
                    "text": "部署完成 memory recall",
                    "truncated": False,
                }
            }
        },
    )
    _append(
        memory,
        "watch",
        ts=3.0,
        content={"hit": True, "condition": "来人", "observation": "门口有人"},
    )
    question = memory.append(
        CONVERSATION_CHANNEL,
        ts=4.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "memory recall 部署怎么样了"},
    )

    view = compile_memory_recall(
        memory,
        query="memory recall 部署怎么样了",
        scope="recent",
        before_ref=question.ref,
    )

    assert view.hits[0].ref == codex_ref
    assert view.hits[0].match == "lexical"


def test_all_zero_scores_fall_back_to_newest_candidates() -> None:
    memory = _memory("ha")
    for index in range(1, 8):
        _append(memory, "ha", ts=float(index), content={"state": f"value-{index}"})
    question = memory.append(
        CONVERSATION_CHANNEL,
        ts=9.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "completely unrelated"},
    )

    view = compile_memory_recall(
        memory,
        query="completely unrelated",
        scope="any",
        before_ref=question.ref,
    )

    assert view.state == "ok"
    assert [hit.ref for hit in view.hits] == [f"ha:{seq}" for seq in range(7, 2, -1)]
    assert {hit.match for hit in view.hits} == {"recency_fallback"}
    assert view.omitted == 2


def test_no_safe_renderable_candidates_returns_empty() -> None:
    memory = _memory("unknown")
    _append(memory, "unknown", ts=1.0, content={"raw": "secret"})
    question = memory.append(
        CONVERSATION_CHANNEL,
        ts=2.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "what happened"},
    )

    view = compile_memory_recall(
        memory,
        query="what happened",
        scope="recent",
        before_ref=question.ref,
    )

    assert view.state == "empty"
    assert view.raw_scanned == 1
    assert view.searched_count == 0
    assert view.hits == ()


def test_recall_order_is_score_then_timestamp_priority_channel_and_seq() -> None:
    memory = _memory("alpha", "beta")
    alpha_1 = _append(
        memory,
        "alpha",
        ts=2.0,
        priority=30,
        content={"message": "target"},
    )
    beta_1 = _append(
        memory,
        "beta",
        ts=2.0,
        priority=40,
        content={"message": "target"},
    )
    beta_2 = _append(
        memory,
        "beta",
        ts=3.0,
        priority=10,
        content={"message": "target"},
    )
    question = memory.append(
        CONVERSATION_CHANNEL,
        ts=4.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "target"},
    )

    view = compile_memory_recall(
        memory,
        query="target",
        scope="recent",
        before_ref=question.ref,
    )

    assert [hit.ref for hit in view.hits] == [beta_2, beta_1, alpha_1]


def test_before_ref_must_name_an_existing_conversation_item() -> None:
    memory = _memory("ha")

    try:
        compile_memory_recall(
            memory,
            query="state",
            scope="recent",
            before_ref="conversation:1",
        )
    except ValueError as exc:
        assert "before_ref" in str(exc)
    else:
        raise AssertionError("expected invalid before_ref to fail")


def test_before_ref_must_name_a_trusted_user_conversation_item() -> None:
    memory = _memory()
    system_item = memory.append(
        CONVERSATION_CHANNEL,
        ts=1.0,
        trust="trusted_system",
        priority=USER_PRIORITY,
        content={"text": "assistant history"},
    )

    with pytest.raises(RecallOriginError, match="trusted user"):
        compile_memory_recall(
            memory,
            query="assistant history",
            scope="recent",
            before_ref=system_item.ref,
        )


def test_recall_state_type_includes_bounded_error_result() -> None:
    assert get_args(recall_module.RecallState) == ("ok", "empty", "error")


def test_encoded_recall_is_valid_json_without_the_query_and_preserves_provenance() -> None:
    view = RecallView(
        state="ok",
        scope="recent",
        raw_scanned=3,
        searched_count=2,
        scan_truncated=False,
        hits=(
            RecallHit(
                ref="codex:7",
                channel="codex",
                ts=12.5,
                trust="untrusted_external",
                outcome="ok",
                match="lexical",
                evidence="Codex 报告已完成",
            ),
        ),
        omitted=1,
    )

    encoded = encode_memory_recall(view)
    payload = json.loads(encoded)

    assert "query" not in payload
    assert payload == {
        "hits": [
            {
                "channel": "codex",
                "evidence": "Codex 报告已完成",
                "match": "lexical",
                "outcome": "ok",
                "ref": "codex:7",
                "trust": "untrusted_external",
                "ts": 12.5,
            }
        ],
        "omitted": 1,
        "raw_scanned": 3,
        "scan_truncated": False,
        "scope": "recent",
        "searched_count": 2,
        "state": "ok",
    }


def test_encoded_recall_shrinks_by_whole_hits_to_fit_character_budget() -> None:
    evidences = tuple(f"evidence-{index}-" + "x" * 220 for index in range(3))
    view = RecallView(
        state="ok",
        scope="any",
        raw_scanned=3,
        searched_count=3,
        scan_truncated=True,
        hits=tuple(
            RecallHit(
                ref=f"ha:{index + 1}",
                channel="ha",
                ts=float(index),
                trust="trusted_system",
                outcome="ok",
                match="recency_fallback",
                evidence=evidence,
            )
            for index, evidence in enumerate(evidences)
        ),
        omitted=0,
    )

    encoded = encode_memory_recall(view, max_chars=600)
    payload = json.loads(encoded)

    assert len(encoded) <= 600
    assert 0 < len(payload["hits"]) < 3
    assert [hit["evidence"] for hit in payload["hits"]] == list(evidences[: len(payload["hits"])])
    assert payload["omitted"] == 3 - len(payload["hits"])
