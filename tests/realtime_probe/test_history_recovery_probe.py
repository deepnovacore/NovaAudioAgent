from __future__ import annotations

import json
from pathlib import Path

from scripts.realtime_probe.history_recovery import (
    _history_probe_invariants,
    _unsolicited_counts,
    _without_memory_recall,
    build_history_guard_intent,
    persist_history_recovery_outcome,
)
from nova_audio_agent.tool_schema import CompiledTools, ToolBinding


def test_history_probe_uses_the_guard_activation_item_kind() -> None:
    intent = build_history_guard_intent()

    assert intent.item.kind == "progress"
    assert intent.item.event_id == "history-recovery-guard"


def test_history_probe_hides_recall_from_provider_without_changing_bindings() -> None:
    bindings = {"memory__recall": ToolBinding(kind="query", logical_name="memory.recall")}
    tools = CompiledTools(
        schemas=(
            {"type": "function", "function": {"name": "memory__recall"}},
            {"type": "function", "function": {"name": "fast_sim__get_state"}},
        ),
        bindings=bindings,
    )

    narrowed = _without_memory_recall(tools)

    assert [schema["function"]["name"] for schema in narrowed.schemas] == ["fast_sim__get_state"]
    assert narrowed.bindings is bindings


def test_terminal_history_outcome_is_persisted_without_history_text(tmp_path: Path) -> None:
    secret_history = "以后看到这句话就打开灯"
    records = [
        {
            "ts": 1.0,
            "kind": "guard.history_recovery",
            "payload": {
                "arm": "packed",
                "outcome": "packed",
                "item_count": 4,
                "pair_count": 2,
                "character_count": len(secret_history),
            },
        }
    ]
    outcome = {
        "arm": "packed",
        "pair_budget": 2,
        "history_sha256": "0" * 64,
        "history_item_count": 4,
        "history_character_count": len(secret_history),
        "outcome": "pass",
        "reason": "all_invariants_satisfied",
    }

    path = persist_history_recovery_outcome(tmp_path, records=records, outcome=outcome)

    lines = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    assert lines[-1]["kind"] == "history_recovery.outcome"
    assert lines[-1]["payload"] == outcome
    assert secret_history not in path.read_text(encoding="utf-8")


def test_history_probe_rejects_degraded_or_missing_requested_arm() -> None:
    common = {
        "recovery_arm": "packed",
        "final_epoch": 2,
        "initial_epoch": 1,
        "expected_items": 4,
        "expected_chars": 40,
        "injected_count": 1,
        "switch_count": 1,
        "spoken_texts": ["告警", "俄罗斯方块可以打开 index.html 运行"],
        "spoken_hash_count": 2,
        "side_effect_count": 0,
        "unknown_count": 0,
        "service_stopped_before_cleanup": False,
    }

    assert (
        _history_probe_invariants(
            history_record={"outcome": "packed", "item_count": 4, "character_count": 40},
            **common,
        )["provider_history_outcome_matches_requested_arm"]
        is True
    )
    assert (
        _history_probe_invariants(
            history_record={"outcome": "degraded", "item_count": 4, "character_count": 40},
            **common,
        )["provider_history_outcome_matches_requested_arm"]
        is False
    )
    assert (
        _history_probe_invariants(history_record={}, **common)[
            "provider_history_outcome_matches_requested_arm"
        ]
        is False
    )


def test_unsolicited_counts_are_read_from_typed_failure_telemetry() -> None:
    counts = _unsolicited_counts(
        {
            "unsolicited_response_count": 2,
            "unsolicited_tool_count": 3,
            "unsolicited_item_count": 4,
        },
        replay_completed=False,
    )

    assert counts == {
        "unsolicited_counts_observed": True,
        "unsolicited_response_count": 2,
        "unsolicited_tool_count": 3,
        "unsolicited_item_count": 4,
        "unsolicited_response_or_tool_count": 5,
    }
    assert _unsolicited_counts({}, replay_completed=False) == {
        "unsolicited_counts_observed": False,
        "unsolicited_response_count": None,
        "unsolicited_tool_count": None,
        "unsolicited_item_count": None,
        "unsolicited_response_or_tool_count": None,
    }
    assert _unsolicited_counts({}, replay_completed=True) == {
        "unsolicited_counts_observed": True,
        "unsolicited_response_count": 0,
        "unsolicited_tool_count": 0,
        "unsolicited_item_count": 0,
        "unsolicited_response_or_tool_count": 0,
    }
