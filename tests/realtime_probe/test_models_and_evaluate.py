from __future__ import annotations

from copy import deepcopy

import pytest

from scripts.realtime_probe.evaluate import (
    evaluate_interruption,
    evaluate_phase_a,
    evaluate_six_gates,
)
from scripts.realtime_probe.models import HostState, ProbeEvent, ProbeReport, SCHEMA_VERSION
from scripts.realtime_probe.scenario import build_scenario


RUN_ID = "run-001"
DELEGATE_ID = "delegate-001"


def event(
    event_ref: str,
    t_ms: int,
    kind: str,
    *,
    actor: str = "host",
    provider: dict[str, str] | None = None,
    **data: object,
) -> ProbeEvent:
    return ProbeEvent(
        event_ref=event_ref,
        t_ms=t_ms,
        kind=kind,
        actor=actor,
        run_id=RUN_ID,
        delegate_id=DELEGATE_ID,
        provider=provider or {},
        data=data,
    )


def phase_a_events() -> list[ProbeEvent]:
    events: list[ProbeEvent] = [
        event(
            "e001",
            10,
            "provider.user_transcript",
            actor="user",
            provider={"item_id": "user-item-1"},
            purpose="delegate",
            text="请让 Codex 写一个俄罗斯方块游戏。",
        ),
        event(
            "e002",
            20,
            "provider.tool_call",
            actor="provider",
            provider={"item_id": "tool-item-1", "call_id": "call-1"},
            tool="delegate_codex",
        ),
        event(
            "e003",
            30,
            "host.delegate_accepted",
            provider={"call_id": "call-1"},
            delegate_status="running",
        ),
        event(
            "e004",
            40,
            "provider.response_done",
            actor="provider",
            provider={"response_id": "response-ack"},
            purpose="delegate_ack",
        ),
    ]
    facts = (
        ("progress-1", "nonce-one", "页面骨架", "item-progress-1", "response-progress-1"),
        ("progress-2", "nonce-two", "碰撞与旋转", "item-progress-2", "response-progress-2"),
        ("progress-3", "nonce-three", "按键与计分", "item-progress-3", "response-progress-3"),
    )
    for index, (progress_id, nonce, term, item_id, response_id) in enumerate(facts, start=1):
        base = 100 * index
        events.extend(
            [
                event(
                    f"e{base + 1}",
                    base,
                    "host.progress_injected",
                    provider={"item_id": item_id},
                    progress_id=progress_id,
                    nonce=nonce,
                    fact=f"Codex 后台进度：已完成{term}",
                    required_terms=[term],
                    snapshot_version=index,
                ),
                event(
                    f"e{base + 2}",
                    base + 10,
                    "provider.item_created",
                    actor="provider",
                    provider={"item_id": item_id},
                    progress_id=progress_id,
                ),
                event(
                    f"e{base + 3}",
                    base + 20,
                    "host.response_create",
                    progress_id=progress_id,
                ),
                event(
                    f"e{base + 4}",
                    base + 30,
                    "assistant.transcript",
                    actor="provider",
                    provider={"response_id": response_id},
                    purpose="progress",
                    cause_event_id=progress_id,
                    text=f"Codex 刚完成了{term}。",
                ),
                event(
                    f"e{base + 5}",
                    base + 40,
                    "host.progress_spoken",
                    progress_id=progress_id,
                ),
                event(
                    f"e{base + 6}",
                    base + 50,
                    "provider.response_done",
                    actor="provider",
                    provider={"response_id": response_id},
                    purpose="progress",
                    cause_event_id=progress_id,
                ),
            ]
        )
    events.append(
        event(
            "e900",
            500,
            "probe.provenance_answer",
            actor="provider",
            provider={"response_id": "response-provenance"},
            text="这些是 Codex 的后台进度，不是你说的。",
        )
    )
    return events


def interruption_events() -> list[ProbeEvent]:
    return [
        event(
            "i001",
            10,
            "provider.audio_delta",
            actor="provider",
            provider={"response_id": "progress-r"},
            purpose="progress",
        ),
        event(
            "i002",
            20,
            "local.playback_rendered",
            provider={"response_id": "progress-r"},
            purpose="progress",
            rendered_bytes=960,
        ),
        event("i003", 30, "local.speech_onset", purpose="barge_in"),
        event(
            "i004",
            31,
            "local.playback_stopped",
            provider={"response_id": "progress-r"},
            cleared_bytes=1920,
            rendered_after_fence_bytes=0,
        ),
        event("i005", 32, "host.response_cancel", provider={"response_id": "progress-r"}),
        event(
            "i006",
            40,
            "provider.response_cancelled",
            actor="provider",
            provider={"response_id": "progress-r"},
            purpose="progress",
            status="cancelled",
            status_details={"reason": "client_cancelled"},
        ),
        event(
            "i007",
            60,
            "provider.user_transcript",
            actor="user",
            provider={"item_id": "barge-item"},
            purpose="barge_in",
            text="顺便问一下，七乘八是多少？",
        ),
        event(
            "i008",
            70,
            "provider.audio_delta",
            actor="provider",
            provider={"response_id": "foreground-r"},
            purpose="foreground",
        ),
        event(
            "i009",
            80,
            "assistant.transcript",
            actor="provider",
            provider={"response_id": "foreground-r"},
            purpose="foreground",
            text="七乘八等于五十六。",
        ),
        event("i010", 90, "host.delegate_status", delegate_status="running"),
    ]


def test_interruption_gate_passes_product_candidate_trace() -> None:
    gate = evaluate_interruption(interruption_events())

    assert gate.status == "pass"
    assert gate.reason_codes == []


def test_interruption_gate_requires_client_cancelled_provider_reason() -> None:
    events = interruption_events()
    cancelled = next(item for item in events if item.kind == "provider.response_cancelled")
    cancelled.data["status_details"] = {"reason": "turn_detected"}

    gate = evaluate_interruption(events)

    assert gate.status == "fail"
    assert "response_not_client_cancelled" in gate.reason_codes


def test_interruption_gate_requires_distinct_progress_and_foreground_responses() -> None:
    events = interruption_events()
    for item in events:
        if item.data.get("purpose") == "foreground" and item.kind in {
            "provider.audio_delta",
            "assistant.transcript",
        }:
            item.provider["response_id"] = "progress-r"

    gate = evaluate_interruption(events)

    assert gate.status == "fail"
    assert "interruption_sequence_incomplete" in gate.reason_codes
    assert {"i001", "i008", "i009"} <= set(gate.evidence_refs)


def test_interruption_gate_rejects_mismatched_progress_response_lifecycle() -> None:
    events = interruption_events()
    next(item for item in events if item.kind == "local.playback_stopped").provider[
        "response_id"
    ] = "other-progress-r"

    gate = evaluate_interruption(events)

    assert gate.status == "fail"
    assert "interruption_sequence_incomplete" in gate.reason_codes


def test_interruption_gate_accepts_multiple_audio_deltas_per_response() -> None:
    events = interruption_events()
    events.extend(
        [
            event(
                "i001a",
                15,
                "provider.audio_delta",
                actor="provider",
                provider={"response_id": "progress-r"},
                purpose="progress",
            ),
            event(
                "i008a",
                75,
                "provider.audio_delta",
                actor="provider",
                provider={"response_id": "foreground-r"},
                purpose="foreground",
            ),
        ]
    )

    gate = evaluate_interruption(events)

    assert gate.status == "pass"


def test_interruption_gate_allows_foreground_audio_before_user_transcript_completion() -> None:
    events = interruption_events()
    next(
        item
        for item in events
        if item.kind == "provider.audio_delta" and item.data.get("purpose") == "foreground"
    ).t_ms = 55

    gate = evaluate_interruption(events)

    assert gate.status == "pass"
    assert gate.reason_codes == []


def test_interruption_gate_allows_user_transcript_after_foreground_transcript() -> None:
    events = interruption_events()
    next(item for item in events if item.kind == "provider.user_transcript").t_ms = 85

    gate = evaluate_interruption(events)

    assert gate.status == "pass"
    assert gate.reason_codes == []


def test_interruption_gate_rejects_mismatched_foreground_audio_response() -> None:
    events = interruption_events()
    next(
        item
        for item in events
        if item.kind == "provider.audio_delta" and item.data.get("purpose") == "foreground"
    ).provider["response_id"] = "other-foreground-r"

    gate = evaluate_interruption(events)

    assert gate.status == "fail"
    assert "interruption_sequence_incomplete" in gate.reason_codes
    assert "i008" in gate.evidence_refs


def test_interruption_gate_handles_malformed_progress_ids_deterministically() -> None:
    events = interruption_events()
    next(item for item in events if item.event_ref == "i001").provider["response_id"] = (
        "other-progress-r"
    )
    events.append(
        event(
            "i011",
            50,
            "assistant.transcript",
            actor="provider",
            provider={"response_id": "progress-r"},
            purpose="progress",
            text="后台进度片段。",
        )
    )

    gate = evaluate_interruption(events)

    assert gate.reason_codes == ["interruption_sequence_incomplete"]
    assert "i001" in gate.evidence_refs
    assert "i011" not in gate.evidence_refs


@pytest.mark.parametrize("purpose", ["progress", "foreground"])
def test_interruption_gate_rejects_empty_response_ids(purpose: str) -> None:
    events = interruption_events()
    response_id = f"{purpose}-r"
    for item in events:
        if item.provider.get("response_id") == response_id:
            item.provider["response_id"] = ""

    gate = evaluate_interruption(events)

    assert gate.status == "fail"
    assert "interruption_sequence_incomplete" in gate.reason_codes


def test_interruption_gate_requires_progress_audio_before_rendering() -> None:
    events = interruption_events()
    next(item for item in events if item.event_ref == "i001").t_ms = 21

    gate = evaluate_interruption(events)

    assert gate.status == "fail"
    assert "interruption_order_invalid" in gate.reason_codes


@pytest.mark.parametrize(
    ("question", "answer"),
    [
        ("请问 7×8 是多少", "当然，七乘以八等于五十六"),
        ("顺便问一下 7 x 8 几", "答案是56"),
        ("七乘以八多少", "五十六"),
        ("七乘八是多少", "七乘八是五十六"),
        ("七乘八是多少", "七乘八得五十六"),
        ("七乘八是多少", "七乘八等于56，不是64"),
    ],
)
def test_interruption_gate_accepts_natural_multiplication_phrasings(
    question: str, answer: str
) -> None:
    events = interruption_events()
    next(item for item in events if item.kind == "provider.user_transcript").data["text"] = question
    next(item for item in events if item.kind == "assistant.transcript").data["text"] = answer

    gate = evaluate_interruption(events)

    assert gate.status == "pass"


def test_interruption_gate_allows_one_partial_progress_transcript_after_cancel() -> None:
    events = interruption_events()
    events.append(
        event(
            "i011",
            50,
            "assistant.transcript",
            actor="provider",
            provider={"response_id": "progress-r"},
            purpose="progress",
            text="后台进度片段。",
        )
    )

    gate = evaluate_interruption(events)

    assert gate.status == "pass"


def test_interruption_gate_rejects_second_progress_transcript_after_cancel() -> None:
    events = interruption_events()
    events.extend(
        [
            event(
                "i011",
                25,
                "assistant.transcript",
                actor="provider",
                provider={"response_id": "progress-r"},
                purpose="progress",
                text="后台进度片段。",
            ),
            event(
                "i012",
                50,
                "assistant.transcript",
                actor="provider",
                provider={"response_id": "progress-r"},
                purpose="progress",
                text="后台进度重播。",
            ),
        ]
    )

    gate = evaluate_interruption(events)

    assert gate.status == "fail"
    assert "progress_replayed_after_cancel" in gate.reason_codes
    assert "i012" in gate.evidence_refs


def test_interruption_gate_rejects_different_progress_response_after_cancel() -> None:
    events = interruption_events()
    events.append(
        event(
            "i011",
            50,
            "assistant.transcript",
            actor="provider",
            provider={"response_id": "other-progress-r"},
            purpose="progress",
            text="其他响应的进度。",
        )
    )

    gate = evaluate_interruption(events)

    assert gate.status == "fail"
    assert "progress_replayed_after_cancel" in gate.reason_codes
    assert "i011" in gate.evidence_refs


def test_interruption_gate_rejects_delegate_nonrunning_after_running() -> None:
    events = interruption_events()
    events.append(event("i011", 91, "host.delegate_status", delegate_status="completed"))

    gate = evaluate_interruption(events)

    assert gate.status == "fail"
    assert "delegate_not_running" in gate.reason_codes
    assert "i011" in gate.evidence_refs


def test_interruption_gate_requires_delegate_running_after_foreground_answer() -> None:
    events = interruption_events()
    next(item for item in events if item.kind == "host.delegate_status").t_ms = 75

    gate = evaluate_interruption(events)

    assert gate.status == "fail"
    assert "interruption_order_invalid" in gate.reason_codes


@pytest.mark.parametrize(
    ("kind", "text"),
    [
        ("provider.user_transcript", "七乘八是不是等于五十六？"),
        ("assistant.transcript", "七乘八等于56，答案64。"),
        ("assistant.transcript", "七乘八等于57，56是旧答案。"),
        ("assistant.transcript", "七乘八等于56，但是64。"),
        ("assistant.transcript", "七乘八等于56，得64。"),
    ],
)
def test_interruption_gate_rejects_adversarial_multiplication_text(kind: str, text: str) -> None:
    events = interruption_events()
    target = next(item for item in events if item.kind == kind)
    target.data["text"] = text

    gate = evaluate_interruption(events)

    assert gate.status == "fail"
    assert (
        "barge_transcript_wrong"
        if kind == "provider.user_transcript"
        else "foreground_answer_wrong"
    ) in gate.reason_codes


@pytest.mark.parametrize(
    ("mutation", "reason"),
    [
        ("completed", "response_not_cancelled"),
        ("rendered_after_fence", "post_fence_audio_rendered"),
        ("wrong_answer", "foreground_answer_wrong"),
        ("wrong_question", "barge_transcript_wrong"),
        ("delegate_cancelled", "barge_in_cancelled_delegate"),
        ("duplicate_progress", "progress_replayed_after_cancel"),
    ],
)
def test_interruption_gate_rejects_semantic_failures(mutation: str, reason: str) -> None:
    events = interruption_events()
    if mutation == "completed":
        next(
            item for item in events if item.kind == "provider.response_cancelled"
        ).kind = "provider.response_done"
    elif mutation == "rendered_after_fence":
        next(item for item in events if item.kind == "local.playback_stopped").data[
            "rendered_after_fence_bytes"
        ] = 960
    elif mutation == "wrong_answer":
        next(
            item
            for item in events
            if item.kind == "assistant.transcript" and item.data.get("purpose") == "foreground"
        ).data["text"] = "七乘八等于五十七。"
    elif mutation == "wrong_question":
        next(
            item
            for item in events
            if item.kind == "provider.user_transcript" and item.data.get("purpose") == "barge_in"
        ).data["text"] = "顺便问一下，八乘八是多少？"
    elif mutation == "delegate_cancelled":
        events.append(event("i011", 85, "host.delegate_cancelled"))
    else:
        events.extend(
            [
                event(
                    "i011",
                    25,
                    "assistant.transcript",
                    actor="provider",
                    provider={"response_id": "progress-r"},
                    purpose="progress",
                    text="后台进度片段。",
                ),
                event(
                    "i012",
                    50,
                    "assistant.transcript",
                    actor="provider",
                    provider={"response_id": "progress-r"},
                    purpose="progress",
                    text="后台进度重播。",
                ),
            ]
        )

    gate = evaluate_interruption(events)

    assert gate.status == "fail"
    assert reason in gate.reason_codes
    if mutation == "delegate_cancelled":
        assert "i011" in gate.evidence_refs


def full_events() -> list[ProbeEvent]:
    events = phase_a_events()[:-1]
    next(
        item
        for item in events
        if item.kind == "host.progress_injected" and item.data.get("progress_id") == "progress-3"
    ).data["snapshot_version"] = 5
    events.extend(
        [
            event(
                "e500",
                145,
                "provider.audio_delta",
                actor="provider",
                provider={"response_id": "response-progress-1"},
                purpose="progress",
                cause_event_id="progress-1",
            ),
            event(
                "e501",
                146,
                "host.barge_in_sent",
                input_bytes=3200,
            ),
            event(
                "e502",
                147,
                "provider.user_transcript",
                actor="user",
                provider={"item_id": "user-item-barge"},
                purpose="barge_in",
                text="顺便问一下，七乘八是多少？",
            ),
            event(
                "e503",
                148,
                "provider.response_cancelled",
                actor="provider",
                provider={"response_id": "response-progress-1"},
                purpose="progress",
            ),
            event(
                "e504",
                180,
                "assistant.transcript",
                actor="provider",
                provider={"response_id": "response-foreground"},
                purpose="foreground",
                text="七乘八等于五十六。",
            ),
            event("e600", 260, "host.connection_dropped", session_id="session-1"),
            event(
                "e601",
                280,
                "host.recovery_snapshot",
                provider={"item_id": "recovery-item-1"},
                snapshot_version=4,
                delegate_status="running",
                delivered_progress_ids=["progress-1", "progress-2"],
            ),
            event(
                "e602",
                290,
                "assistant.transcript",
                actor="provider",
                provider={"response_id": "response-recovery"},
                purpose="recovery",
                text="俄罗斯方块任务仍在进行，我会继续等可靠结果。",
            ),
            event(
                "e700",
                420,
                "host.delegate_final",
                result="俄罗斯方块已完成，交付单文件 index.html。",
            ),
            event(
                "e701",
                430,
                "host.final_injected",
                provider={"item_id": "final-item-1"},
                final_id="final-1",
            ),
            event(
                "e702",
                440,
                "host.final_spoken",
                final_id="final-1",
            ),
            event(
                "e703",
                450,
                "assistant.transcript",
                actor="provider",
                provider={"response_id": "response-followup"},
                purpose="context_followup",
                text="刚才委派的是俄罗斯方块，最终交付是单文件 index.html。",
            ),
        ]
    )
    return sorted(events, key=lambda item: (item.t_ms, item.event_ref))


def integrated_full_events() -> list[ProbeEvent]:
    events = [
        item
        for item in full_events()
        if item.event_ref not in {"e500", "e501", "e502", "e503", "e504"}
        and not (
            item.kind == "host.progress_spoken" and item.data.get("progress_id") == "progress-1"
        )
        and not (
            item.kind == "provider.response_done"
            and item.data.get("cause_event_id") == "progress-1"
        )
    ]
    next(
        item
        for item in events
        if item.kind == "host.progress_injected" and item.data.get("progress_id") == "progress-2"
    ).data["snapshot_version"] = 3
    recovery = next(item for item in events if item.kind == "host.recovery_snapshot")
    recovery.data["delivered_progress_ids"] = ["progress-2"]
    recovery.data["interrupted_progress_ids"] = ["progress-1"]
    events.extend(
        [
            event(
                "i500",
                145,
                "provider.audio_delta",
                actor="provider",
                provider={"response_id": "response-progress-1"},
                purpose="progress",
                cause_event_id="progress-1",
            ),
            event(
                "i501",
                146,
                "local.playback_rendered",
                provider={"response_id": "response-progress-1"},
                purpose="progress",
                cause_event_id="progress-1",
            ),
            event(
                "i502",
                147,
                "local.speech_onset",
                purpose="barge_in",
                cause_event_id="progress-1",
            ),
            event(
                "i503",
                148,
                "local.playback_stopped",
                provider={"response_id": "response-progress-1"},
                purpose="progress",
                cause_event_id="progress-1",
                rendered_after_fence_bytes=0,
            ),
            event(
                "i504",
                149,
                "host.response_cancel",
                provider={"response_id": "response-progress-1"},
                purpose="progress",
                cause_event_id="progress-1",
            ),
            event("i505", 150, "host.barge_in_sent", input_bytes=3200),
            event(
                "i506",
                151,
                "provider.response_cancelled",
                actor="provider",
                provider={"response_id": "response-progress-1"},
                purpose="progress",
                cause_event_id="progress-1",
                status="cancelled",
                status_details={"reason": "client_cancelled"},
            ),
            event(
                "i507",
                160,
                "provider.audio_delta",
                actor="provider",
                provider={"response_id": "response-foreground"},
                purpose="foreground",
            ),
            event(
                "i508",
                170,
                "provider.user_transcript",
                actor="user",
                provider={"item_id": "user-item-barge"},
                purpose="barge_in",
                text="顺便问一下，七乘八是多少？",
            ),
            event(
                "i509",
                180,
                "assistant.transcript",
                actor="provider",
                provider={"response_id": "response-foreground"},
                purpose="foreground",
                text="七乘八等于五十六。",
            ),
            event(
                "i510",
                185,
                "host.progress_interrupted",
                provider={"response_id": "response-progress-1"},
                progress_id="progress-1",
            ),
            event("i511", 190, "host.delegate_status", delegate_status="running"),
        ]
    )
    return sorted(events, key=lambda item: (item.t_ms, item.event_ref))


def gate_statuses(events: list[ProbeEvent]) -> dict[int, str]:
    return {gate.gate: gate.status for gate in evaluate_six_gates(events)}


def test_models_round_trip_without_secret_fields() -> None:
    original = event("e1", 1, "host.progress_injected", token="must-not-be-a-model-field")
    restored = ProbeEvent.from_dict(original.to_dict())

    assert restored == original
    assert SCHEMA_VERSION == "realtime-probe.v1"
    assert "api_key" not in original.to_dict()


def test_host_state_tracks_monotonic_projection_without_duplicates() -> None:
    state = HostState(run_id=RUN_ID, delegate_id=DELEGATE_ID)

    state.mark_injected("progress-1")
    state.mark_spoken("progress-1")
    state.mark_injected("progress-1")

    assert state.snapshot_version == 2
    assert state.injected_progress_ids == ["progress-1"]
    assert state.spoken_progress_ids == ["progress-1"]


def test_host_state_tracks_interrupted_progress_without_claiming_it_was_spoken() -> None:
    state = HostState(run_id=RUN_ID, delegate_id=DELEGATE_ID)

    state.mark_injected("progress-1")
    state.mark_interrupted("progress-1")
    state.mark_interrupted("progress-1")

    assert state.snapshot_version == 2
    assert state.interrupted_progress_ids == ["progress-1"]
    assert state.spoken_progress_ids == []
    assert state.recovery_projection()["interrupted_progress_ids"] == ["progress-1"]

    with pytest.raises(ValueError, match="terminal disposition"):
        state.mark_spoken("progress-1")


def test_shared_scenario_contains_the_required_script() -> None:
    scenario = build_scenario("full")

    assert [step.kind for step in scenario].count("progress") == 3
    assert "barge_in" in [step.kind for step in scenario]
    assert "disconnect" in [step.kind for step in scenario]
    assert scenario[-1].kind == "context_followup"


def test_phase_a_passes_for_three_clean_progress_updates() -> None:
    gate = evaluate_phase_a(phase_a_events())

    assert gate.gate == 4
    assert gate.status == "pass"
    assert gate.evidence_refs


@pytest.mark.parametrize(
    ("mutation", "reason_code"),
    [
        ("misattribute", "progress_misattributed_to_user"),
        ("leak_nonce", "progress_internal_marker_leaked"),
        ("wrong_source", "provenance_answer_wrong"),
        ("wrong_order", "progress_trigger_order_invalid"),
    ],
)
def test_phase_a_rejects_unclean_injection(mutation: str, reason_code: str) -> None:
    events = phase_a_events()
    if mutation == "misattribute":
        next(item for item in events if item.kind == "assistant.transcript").data["text"] = (
            "你刚才说页面骨架完成了。"
        )
    elif mutation == "leak_nonce":
        next(item for item in events if item.kind == "assistant.transcript").data["text"] += (
            " nonce-one"
        )
    elif mutation == "wrong_source":
        events[-1].data["text"] = "这些都是你刚才说的。"
    else:
        response_create = next(item for item in events if item.kind == "host.response_create")
        response_create.t_ms = 95

    gate = evaluate_phase_a(events)

    assert gate.status == "fail"
    assert reason_code in gate.reason_codes


def test_all_six_gates_pass_for_the_shared_scenario() -> None:
    gates = evaluate_six_gates(full_events())
    report = ProbeReport.for_run(
        provider="qwen",
        model="qwen-audio-3.0-realtime-plus",
        phase="full",
        run_id=RUN_ID,
        gates=gates,
    )

    assert [gate.status for gate in gates] == ["pass"] * 6
    assert report.status == "pass"


def test_integrated_full_passes_with_interrupted_progress_truth() -> None:
    gates = evaluate_six_gates(integrated_full_events(), strict_interruption=True)

    assert [gate.status for gate in gates] == ["pass"] * 6


def test_integrated_gate_three_ignores_later_progress_responses() -> None:
    events = integrated_full_events()
    events.append(
        event(
            "later-progress-audio",
            260,
            "provider.audio_delta",
            actor="provider",
            provider={"response_id": "unrelated-later-progress"},
            purpose="progress",
            cause_event_id="progress-2",
        )
    )

    gate = evaluate_six_gates(events, strict_interruption=True)[2]

    assert gate.status == "pass"


def test_integrated_progress_cannot_be_both_interrupted_and_spoken() -> None:
    events = integrated_full_events()
    events.append(
        event(
            "conflicting-p1-terminal",
            186,
            "host.progress_spoken",
            progress_id="progress-1",
        )
    )

    gates = evaluate_six_gates(events, strict_interruption=True)

    assert "progress_terminal_disposition_conflict" in gates[3].reason_codes
    assert "progress_delivery_duplicate_or_missing" in gates[4].reason_codes


def test_integrated_recovery_snapshot_must_include_interrupted_progress() -> None:
    events = integrated_full_events()
    recovery = next(item for item in events if item.kind == "host.recovery_snapshot")
    recovery.data["interrupted_progress_ids"] = []

    gate = evaluate_six_gates(events, strict_interruption=True)[4]

    assert gate.status == "fail"
    assert "recovery_progress_history_mismatch" in gate.reason_codes


def test_integrated_recovery_cannot_replay_a_terminal_progress() -> None:
    events = integrated_full_events()
    recovery = next(item for item in events if item.kind == "host.recovery_snapshot")
    original = next(
        item
        for item in events
        if item.kind == "host.progress_injected" and item.data.get("progress_id") == "progress-1"
    )
    replay = deepcopy(original)
    replay.event_ref = "replayed-progress-1"
    replay.t_ms = recovery.t_ms + 1
    replay.provider["item_id"] = "replayed-progress-item-1"
    confirmation = event(
        "replayed-progress-confirmation",
        replay.t_ms + 1,
        "provider.item_created",
        actor="provider",
        provider={"item_id": "replayed-progress-item-1"},
        progress_id="progress-1",
    )
    events.extend([replay, confirmation])

    gate = evaluate_six_gates(events, strict_interruption=True)[4]

    assert gate.status == "fail"
    assert "recovery_replayed_progress" in gate.reason_codes


def test_synchronization_ignores_confirmations_for_non_progress_items() -> None:
    events = full_events()
    events.append(
        event(
            "e-extra",
            425,
            "provider.item_created",
            actor="provider",
            provider={"item_id": "recovery-or-function-output"},
        )
    )

    assert gate_statuses(events)[5] == "pass"


def test_foreground_gate_fails_semantically_when_progress_is_not_cancelled() -> None:
    events = full_events()
    cancellation = next(item for item in events if item.kind == "provider.response_cancelled")
    cancellation.kind = "provider.response_done"
    next(
        item
        for item in events
        if item.kind == "provider.user_transcript" and item.data.get("purpose") == "barge_in"
    ).t_ms = cancellation.t_ms + 1

    gate = evaluate_six_gates(events)[2]

    assert gate.status == "fail"
    assert "barge_in_did_not_stop_response" in gate.reason_codes
    assert "barge_in_sequence_incomplete" not in gate.reason_codes
    assert "barge_in_order_invalid" not in gate.reason_codes


@pytest.mark.parametrize(
    ("gate", "mutate"),
    [
        (1, lambda events: events[0].provider.clear()),
        (
            2,
            lambda events: setattr(
                next(item for item in events if item.kind == "host.delegate_accepted"),
                "t_ms",
                500,
            ),
        ),
        (
            3,
            lambda events: events.append(event("cancel", 170, "host.delegate_cancelled")),
        ),
        (
            4,
            lambda events: next(
                item
                for item in events
                if item.kind == "assistant.transcript" and item.data.get("purpose") == "progress"
            ).data.update(text="你刚才说页面骨架完成了。"),
        ),
        (
            5,
            lambda events: events.append(
                deepcopy(next(item for item in events if item.kind == "host.final_spoken"))
            ),
        ),
        (
            6,
            lambda events: next(
                item
                for item in events
                if item.kind == "assistant.transcript" and item.data.get("purpose") == "recovery"
            ).data.update(text="任务已经全部完成。"),
        ),
    ],
)
def test_each_full_gate_has_a_negative_trajectory(gate: int, mutate: object) -> None:
    events = full_events()
    mutate(events)  # type: ignore[operator]

    assert gate_statuses(events)[gate] == "fail"
