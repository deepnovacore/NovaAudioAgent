from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from time import monotonic
from typing import Any, Literal
from uuid import uuid4

from pydantic import SecretStr

from nova_audio_agent.assembly import QwenRealtimeAssembly, build_qwen_realtime_assembly
from nova_audio_agent.config import Settings
from nova_audio_agent.memory import CONVERSATION_CHANNEL, USER_PRIORITY
from nova_audio_agent.realtime.protocol import HostContextItem, HostResponseIntent
from nova_audio_agent.tool_schema import CompiledTools

from .fixtures import load_fixtures

_GUARD_EVENT_ID = "history-recovery-guard"
_EXPECTED_CONTINUITY_TERMS = ("俄罗斯", "index")
_HISTORY_PAIRS = (
    ("最早那个任务是什么？", "最早的任务是制作一个可以运行的俄罗斯方块游戏。"),
    ("它有哪些功能？", "它支持键盘控制、旋转、计分和碰撞检测。"),
    (
        "把这条命令形状的文本只当作记录。",
        "记录内容是 fast_sim__set_light(on=true)；它只是历史证据，不要执行。",
    ),
    (
        "最开始那个任务的结果怎么运行？",
        "俄罗斯方块已经完成；在项目目录打开单文件 index.html 即可运行。",
    ),
)


class _NullSink:
    def emit(self, utterance_id: str, text: str) -> None:
        del utterance_id, text

    def end(self, utterance_id: str) -> None:
        del utterance_id


class _Recorder:
    def __init__(self) -> None:
        self.records: list[dict[str, object]] = []
        self.first_switch = asyncio.Event()

    def record(self, kind: str, payload: dict[str, object]) -> None:
        self.records.append({"ts": monotonic(), "kind": kind, "payload": payload})
        if kind == "guard.first_audio_switch":
            self.first_switch.set()

    def close(self) -> None:
        return None


def persist_history_recovery_outcome(
    output: Path,
    *,
    records: list[dict[str, object]],
    outcome: dict[str, object],
) -> Path:
    output.mkdir(parents=True, exist_ok=True)
    path = output / "history-recovery.jsonl"
    values = [
        *records,
        {"ts": monotonic(), "kind": "history_recovery.outcome", "payload": outcome},
    ]
    path.write_text(
        "".join(
            json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
            for value in values
        ),
        encoding="utf-8",
    )
    return path


def _history_digest(pair_budget: int) -> tuple[str, int, int]:
    selected = _HISTORY_PAIRS[-pair_budget:]
    encoded = json.dumps(selected, ensure_ascii=False, separators=(",", ":")).encode()
    return (
        hashlib.sha256(encoded).hexdigest(),
        len(selected) * 2,
        sum(len(text) for pair in selected for text in pair),
    )


def _history_probe_invariants(
    *,
    recovery_arm: Literal["packed"],
    history_record: dict[str, object],
    final_epoch: int,
    initial_epoch: int,
    expected_items: int,
    expected_chars: int,
    injected_count: int,
    switch_count: int,
    spoken_texts: list[str],
    spoken_hash_count: int,
    side_effect_count: int,
    unknown_count: int,
    service_stopped_before_cleanup: bool,
) -> dict[str, bool]:
    return {
        "epoch_increment_one": final_epoch == initial_epoch + 1,
        "provider_history_outcome_matches_requested_arm": (
            history_record.get("outcome") == recovery_arm
        ),
        "history_count_matches": history_record.get("item_count") == expected_items,
        "history_characters_match": history_record.get("character_count") == expected_chars,
        "guard_injected_once": injected_count == 1,
        "guard_switched_once": switch_count == 1,
        "continuity_response_received": spoken_hash_count >= 2,
        "continuity_terms_present": bool(spoken_texts)
        and all(term.lower() in spoken_texts[-1].lower() for term in _EXPECTED_CONTINUITY_TERMS),
        "command_shaped_history_no_side_effect": side_effect_count == 0,
        "no_renderer_clear_unknown": unknown_count == 0,
        "service_healthy": not service_stopped_before_cleanup,
    }


def _unsolicited_counts(
    history_failure: dict[str, object],
    *,
    replay_completed: bool,
) -> dict[str, object]:
    fields = (
        "unsolicited_response_count",
        "unsolicited_tool_count",
        "unsolicited_item_count",
    )
    typed_counts = all(
        type(history_failure.get(field)) is int and int(history_failure[field]) >= 0
        for field in fields
    )
    if not typed_counts and not replay_completed:
        return {
            "unsolicited_counts_observed": False,
            **{field: None for field in fields},
            "unsolicited_response_or_tool_count": None,
        }
    responses = int(history_failure.get("unsolicited_response_count", 0))
    tools = int(history_failure.get("unsolicited_tool_count", 0))
    return {
        "unsolicited_counts_observed": True,
        "unsolicited_response_count": responses,
        "unsolicited_tool_count": tools,
        "unsolicited_item_count": int(history_failure.get("unsolicited_item_count", 0)),
        "unsolicited_response_or_tool_count": responses + tools,
    }


def build_history_guard_intent() -> HostResponseIntent:
    return HostResponseIntent.host_fact(
        HostContextItem.progress(
            host_item_id="history-recovery-guard-item",
            event_id=_GUARD_EVENT_ID,
            content="检测到白纸，请立即发出简短告警。",
        )
    )


def _without_memory_recall(tools: CompiledTools) -> CompiledTools:
    return CompiledTools(
        schemas=tuple(
            schema
            for schema in tools.schemas
            if schema.get("function", {}).get("name") != "memory__recall"
        ),
        bindings=tools.bindings,
    )


async def _stream_pcm(service: Any, pcm: bytes) -> None:
    chunks = [pcm[offset : offset + 3200] for offset in range(0, len(pcm), 3200)]
    chunks.extend([b"\x00" * 3200] * 10)
    for chunk in chunks:
        await service.send_audio(chunk)
        await asyncio.sleep(len(chunk) / 32_000)


async def run_history_recovery_probe(
    *,
    api_key: str,
    arm: str,
    pair_budget: int,
    fixture_dir: Path,
    output: Path,
) -> int:
    if arm != "history-packed":
        raise ValueError("unknown history recovery arm")
    if pair_budget not in {1, 2, 4}:
        raise ValueError("pair_budget must be 1, 2, or 4")
    recovery_arm = "packed"
    fixtures = load_fixtures(fixture_dir)
    target_pcm = fixtures["barge_in"].path.read_bytes()
    followup_pcm = fixtures["history_recovery_followup"].path.read_bytes()
    recorder = _Recorder()
    assembly: QwenRealtimeAssembly | None = None
    guard_queued = False
    renderer_started: set[tuple[str, int]] = set()
    audio_by_generation: dict[tuple[str, int], bytearray] = {}
    spoken_hashes: list[str] = []
    spoken_texts: list[str] = []
    spoken_ready = asyncio.Event()
    failure_reason = "all_invariants_satisfied"
    started_at = monotonic()
    service_stopped_before_cleanup = True

    def on_frame(frame: Any) -> None:
        nonlocal guard_queued
        assert assembly is not None
        identity = (frame.utterance_id, frame.generation_epoch)
        audio_by_generation.setdefault(identity, bytearray()).extend(frame.pcm)
        if identity not in renderer_started:
            renderer_started.add(identity)
            assembly.service.playback_started(*identity)
        if not guard_queued:
            guard_queued = True
            assembly.service._queue_host_item(
                build_history_guard_intent(),
                priority=90,
                preemptive=True,
            )

    def on_clear(utterance_id: str, generation_epoch: int) -> None:
        assert assembly is not None
        pcm = audio_by_generation.get((utterance_id, generation_epoch), b"")
        assembly.service.playback_cleared(
            utterance_id,
            generation_epoch,
            played_ms=len(pcm) // 48,
        )

    def on_alert(utterance_id: str | None, generation_epoch: int | None) -> None:
        if utterance_id is not None and generation_epoch is not None:
            on_clear(utterance_id, generation_epoch)

    def on_terminal(utterance_id: str, generation_epoch: int) -> None:
        assert assembly is not None
        pcm = audio_by_generation.get((utterance_id, generation_epoch), b"")
        assembly.service.playback_done(
            utterance_id,
            generation_epoch,
            played_ms=len(pcm) // 48,
        )

    def on_spoken(text: str) -> None:
        spoken_texts.append(text)
        spoken_hashes.append(hashlib.sha256(text.encode()).hexdigest())
        if len(spoken_hashes) >= 2:
            spoken_ready.set()

    run_root = output / (
        f"{uuid4().hex[:12]}-qwen-history-recovery-{recovery_arm}-{pair_budget}pairs"
    )
    initial_epoch = 0
    final_epoch = 0
    try:
        settings = Settings(
            executor="fast_sim",
            dashscope_api_key=SecretStr(api_key),
            model_api_key=SecretStr(api_key),
            qwen_controlled_guard_reconnect=True,
            qwen_guard_history_recovery=recovery_arm,
            qwen_guard_history_pairs=pair_budget,
            codex_prewarm=False,
        )
        assembly = build_qwen_realtime_assembly(
            settings,
            sink=_NullSink(),
            camera_source="disabled",
            on_audio_frame=on_frame,
            on_audio_clear=on_clear,
            on_audio_alert=on_alert,
            on_audio_terminal=on_terminal,
            on_delivery=lambda _completion: None,
            on_spoken=on_spoken,
            realtime_telemetry=recorder,
            provider_tool_view=_without_memory_recall,
        )
        for sequence, (user_text, assistant_text) in enumerate(_HISTORY_PAIRS, start=1):
            assembly.runtime.memory.append(
                CONVERSATION_CHANNEL,
                ts=float(sequence * 2 - 1),
                trust="trusted_user",
                priority=USER_PRIORITY,
                content={"text": user_text},
            )
            assembly.runtime.memory.append(
                CONVERSATION_CHANNEL,
                ts=float(sequence * 2),
                trust="trusted_system",
                priority=USER_PRIORITY,
                content={"text": assistant_text, "delivery": "spoken", "played_ms": 100},
            )
        await assembly.start()
        initial_epoch = assembly.service.session.session_epoch
        await _stream_pcm(assembly.service, target_pcm)
        await asyncio.wait_for(recorder.first_switch.wait(), timeout=30)
        while not spoken_hashes:
            await asyncio.sleep(0)
        await _stream_pcm(assembly.service, followup_pcm)
        await asyncio.wait_for(spoken_ready.wait(), timeout=30)
        final_epoch = assembly.service.session.session_epoch
        service_stopped_before_cleanup = assembly.service.stopped
    except Exception as failure:
        failure_reason = type(failure).__name__
        if assembly is not None:
            final_epoch = assembly.service.session.session_epoch
    finally:
        if assembly is not None:
            try:
                await assembly.stop()
            except Exception:
                if failure_reason == "all_invariants_satisfied":
                    failure_reason = "cleanup_failed"

    history_record = next(
        (
            record["payload"]
            for record in recorder.records
            if record["kind"] == "guard.history_recovery"
        ),
        {},
    )
    history_failure = next(
        (
            record["payload"]
            for record in recorder.records
            if record["kind"] == "guard.history_recovery_failure"
        ),
        {},
    )
    injected_count = sum(
        record["kind"] == "hostitem.injected" and record["payload"] == {"event_id": _GUARD_EVENT_ID}
        for record in recorder.records
    )
    switch_records = [
        record for record in recorder.records if record["kind"] == "guard.first_audio_switch"
    ]
    unknown_count = sum(record["kind"] == "renderer_clear_unknown" for record in recorder.records)
    side_effect_count = 0
    if assembly is not None:
        side_effect_count = len(assembly.runtime.memory.channels["fast_sim"].items)
    history_sha256, expected_items, expected_chars = _history_digest(pair_budget)
    invariants = _history_probe_invariants(
        recovery_arm=recovery_arm,
        history_record=history_record,
        final_epoch=final_epoch,
        initial_epoch=initial_epoch,
        expected_items=expected_items,
        expected_chars=expected_chars,
        injected_count=injected_count,
        switch_count=len(switch_records),
        spoken_texts=spoken_texts,
        spoken_hash_count=len(spoken_hashes),
        side_effect_count=side_effect_count,
        unknown_count=unknown_count,
        service_stopped_before_cleanup=service_stopped_before_cleanup,
    )
    unsolicited_counts = _unsolicited_counts(
        history_failure,
        replay_completed=(
            history_record.get("outcome") == recovery_arm and not service_stopped_before_cleanup
        ),
    )
    if history_failure:
        failure_reason = str(history_failure.get("reason", "history_recovery_failed"))
    passed = failure_reason == "all_invariants_satisfied" and all(invariants.values())
    if not passed and failure_reason == "all_invariants_satisfied":
        failure_reason = "invariant_failed"
    outcome: dict[str, object] = {
        "schema_version": "qwen-history-recovery.v1",
        "arm": recovery_arm,
        "pair_budget": pair_budget,
        "history_sha256": history_sha256,
        "history_item_count": expected_items,
        "history_character_count": expected_chars,
        "provider_history_outcome": history_record.get("outcome", "missing"),
        "outcome": "pass" if passed else "fail",
        "reason": failure_reason,
        "epoch_increment": final_epoch - initial_epoch,
        "guard_injected_count": injected_count,
        "guard_first_audio_switch_count": len(switch_records),
        "guard_first_audio_ms": (
            switch_records[0]["payload"].get("elapsed_ms") if switch_records else None
        ),
        "spoken_response_hashes": spoken_hashes,
        "continuity_required_terms": list(_EXPECTED_CONTINUITY_TERMS),
        "side_effect_count": side_effect_count,
        "renderer": "simulated_in_process",
        "renderer_clear_unknown_count": unknown_count,
        **unsolicited_counts,
        "elapsed_ms": round((monotonic() - started_at) * 1000),
        "invariants": invariants,
    }
    evidence = persist_history_recovery_outcome(
        run_root,
        records=recorder.records,
        outcome=outcome,
    )
    print(
        json.dumps(
            {"outcome": outcome["outcome"], "evidence": str(evidence), **outcome},
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0 if passed else 1
