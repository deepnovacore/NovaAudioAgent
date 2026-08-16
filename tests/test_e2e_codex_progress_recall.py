from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Literal

import pytest

from nova_audio_agent.clock import RealClock
from nova_audio_agent.context_view import ContextView
from nova_audio_agent.events import ProgressEvent
from nova_audio_agent.executors.codex_live import CODEX_LIVE_MANIFEST, CodexLiveAdapter
from nova_audio_agent.memory import CONVERSATION_CHANNEL, USER_PRIORITY, Memory
from nova_audio_agent.ports import Delegate, SurrogateOutput
from nova_audio_agent.realtime.protocol import (
    ResponseAudioDelta,
    ResponseStarted,
    ResponseTerminal,
    ResponseTranscriptFinal,
)
from nova_audio_agent.realtime.service import RealtimeService
from nova_audio_agent.runtime import Runtime
from test_e2e_memory_recall import (
    HistoricalRecallResult,
    MemorySnapshot,
    RecallProvider,
    build_memory_recall_service,
    historical_recall_turn,
    snapshot_memory,
)

SILENT_SUMMARY = "检查后确认旧版只把笔记保存在页面内存中，刷新会丢失"
MILESTONE_SUMMARY = "自动保存与刷新恢复已完成，Node 测试全部通过"


class _Telemetry:
    def __init__(self) -> None:
        self.records: list[tuple[str, dict[str, object]]] = []

    def record(self, kind: str, payload: dict[str, object]) -> None:
        self.records.append((kind, payload))

    def payloads(self, kind: str) -> tuple[dict[str, object], ...]:
        return tuple(payload for current, payload in self.records if current == kind)


Decision = Literal["silent", "select", "unoffered"]


class _ScriptedSurrogate:
    def __init__(self, decisions: tuple[Decision, ...]) -> None:
        self._decisions = iter(decisions)
        self.runtime: Runtime | None = None
        self.calls = 0

    async def watch(self, view: ContextView) -> SurrogateOutput:
        self.calls += 1
        decision = next(self._decisions)
        offered = tuple(item.ref for item in view.affordances if item.source == "suggestion")
        if decision == "silent":
            return SurrogateOutput(speak=False, reason="记录即可")
        if decision == "select":
            assert len(offered) == 1
            return SurrogateOutput(
                speak=True,
                suggestion_id=offered[0],
                reason="这个里程碑值得现在告知用户",
            )
        assert self.runtime is not None
        unoffered = self.runtime.suggestions.add(
            origin="executor",
            kind="notify",
            content={"summary": "这个候选在本次视图编译之后才出现"},
        )
        assert unoffered.id not in offered
        return SurrogateOutput(
            speak=True,
            suggestion_id=unoffered.id,
            reason="注入未提供候选",
        )


@dataclass(frozen=True, slots=True)
class _SilentRecallEvidence:
    attention: tuple[dict[str, object], ...]
    host_event_ids: tuple[str, ...]
    memory_before_recall: MemorySnapshot
    recall: HistoricalRecallResult
    delegates_before_recall: tuple[Delegate, ...]
    delegates_after_recall: tuple[Delegate, ...]
    admissions: tuple[dict[str, object], ...]


def _codex_delegate(origin_ref: str) -> Delegate:
    return Delegate(
        delegate_id="d-codex",
        executor="codex",
        op="run",
        request={"work_order": "检查旧版笔记为什么刷新会丢失"},
        origin_ref=origin_ref,
        deadline=180.0,
        routing_class="user_awaited",
        dispatched_at=0.0,
    )


def _progress(summary: str, *, internal_activity: int) -> ProgressEvent:
    return ProgressEvent(
        channel="codex",
        delegate_id="d-codex",
        op="run",
        phase="working",
        internal_activity=internal_activity,
        elapsed=4.0,
        summary=summary,
    )


async def _run_until_attention_decision(
    runtime: Runtime,
    telemetry: _Telemetry,
    *,
    count: int,
) -> None:
    for _ in range(100):
        if len(telemetry.payloads("attention.decision")) >= count:
            return
        await asyncio.sleep(0)
    raise AssertionError(f"attention decision {count} did not arrive; applied={runtime.applied!r}")


def _build_chain(
    decisions: tuple[Decision, ...],
) -> tuple[
    Runtime,
    RealtimeService,
    RecallProvider,
    _Telemetry,
    _ScriptedSurrogate,
]:
    telemetry = _Telemetry()
    surrogate = _ScriptedSurrogate(decisions)
    service_outlet: list[RealtimeService] = []
    memory = Memory(policies=(CODEX_LIVE_MANIFEST.policy,))
    runtime = Runtime(
        clock=RealClock(),
        memory=memory,
        surrogate=surrogate,
        executors={"codex": CodexLiveAdapter(object())},  # type: ignore[arg-type]
        on_suggestion_selected=lambda suggestion, reason: service_outlet[0].on_suggestion_selected(
            suggestion, reason
        ),
        on_attention_decision=lambda decision: service_outlet[0].on_attention_decision(decision),
    )
    surrogate.runtime = runtime
    service, provider = build_memory_recall_service(
        runtime,
        manifests=(CODEX_LIVE_MANIFEST,),
        telemetry=telemetry,
    )
    service_outlet.append(service)
    origin = memory.append(
        CONVERSATION_CHANNEL,
        ts=runtime.clock.now(),
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "请处理之前交代的任务"},
    )
    runtime.delegates.dispatch(_codex_delegate(origin.ref))
    return runtime, service, provider, telemetry, surrogate


async def _exercise_silent_recall(
    *,
    decision: Decision = "silent",
) -> _SilentRecallEvidence:
    runtime, service, _provider, telemetry, _surrogate = _build_chain((decision,))
    await service.connect()
    stop = asyncio.Event()
    runner = asyncio.create_task(runtime.serve(stop))
    try:
        runtime.post(_progress(SILENT_SUMMARY, internal_activity=1))
        await _run_until_attention_decision(runtime, telemetry, count=1)
        attention = telemetry.payloads("attention.decision")
        host_event_ids = tuple(queued.intent.item.event_id for queued in service._host_items)
        memory_before_recall = snapshot_memory(runtime.memory)
        delegates_before_recall = runtime.delegates.snapshot()
        recall = await historical_recall_turn(
            service,
            query="Codex 刚才记录的旧版本为什么一刷新笔记就没了？只回答它当时记录的原因。",
        )
        return _SilentRecallEvidence(
            attention=attention,
            host_event_ids=host_event_ids,
            memory_before_recall=memory_before_recall,
            recall=recall,
            delegates_before_recall=delegates_before_recall,
            delegates_after_recall=runtime.delegates.snapshot(),
            admissions=telemetry.payloads("tool.admission"),
        )
    finally:
        stop.set()
        await runner
        await service.close()


async def _progress_host_event_ids(*, decision: Decision = "silent") -> tuple[str, ...]:
    runtime, service, _provider, telemetry, _surrogate = _build_chain((decision,))
    await service.connect()
    stop = asyncio.Event()
    runner = asyncio.create_task(runtime.serve(stop))
    try:
        runtime.post(_progress(SILENT_SUMMARY, internal_activity=1))
        await _run_until_attention_decision(runtime, telemetry, count=1)
        return tuple(queued.intent.item.event_id for queued in service._host_items)
    finally:
        stop.set()
        await runner
        await service.close()


@pytest.mark.asyncio
async def test_silent_codex_progress_is_canonical_and_recalled_inline() -> None:
    evidence = await _exercise_silent_recall()

    silent_ref = evidence.attention[0]["memory_ref"]
    assert evidence.attention == (
        {
            "channel": "codex",
            "memory_ref": silent_ref,
            "speak": False,
            "selected": False,
        },
    )
    assert evidence.host_event_ids == ()
    first_hit = evidence.recall.payload["hits"][0]
    assert first_hit["ref"] == silent_ref
    assert first_hit["channel"] == "codex"
    assert first_hit["trust"] == "trusted_system"
    assert first_hit["outcome"] is None
    assert first_hit["evidence"] == SILENT_SUMMARY
    assert evidence.recall.before_inline_memory == evidence.recall.after_inline_memory
    before_codex = next(
        channel for channel in evidence.memory_before_recall.channels if channel[0] == "codex"
    )
    after_codex = next(
        channel for channel in evidence.recall.after_inline_memory.channels if channel[0] == "codex"
    )
    assert after_codex == before_codex
    assert evidence.delegates_after_recall == evidence.delegates_before_recall
    assert evidence.admissions == ({"logical_name": "memory.recall", "outcome": "inline"},)


@pytest.mark.asyncio
async def test_selected_milestone_projects_once_and_only_it_fires_after_playback() -> None:
    runtime, service, provider, telemetry, surrogate = _build_chain(("silent", "select"))
    await service.connect()
    stop = asyncio.Event()
    runner = asyncio.create_task(runtime.serve(stop))
    try:
        runtime.post(_progress(SILENT_SUMMARY, internal_activity=1))
        await _run_until_attention_decision(runtime, telemetry, count=1)
        silent_ref = telemetry.payloads("attention.decision")[0]["memory_ref"]
        silent = next(
            suggestion
            for suggestion in runtime.suggestions.all()
            if suggestion.evidence_refs == (silent_ref,)
        )

        runtime.post(_progress(MILESTONE_SUMMARY, internal_activity=2))
        await _run_until_attention_decision(runtime, telemetry, count=2)
        selected_ref = telemetry.payloads("attention.decision")[1]["memory_ref"]
        selected = next(
            suggestion
            for suggestion in runtime.suggestions.all()
            if suggestion.evidence_refs == (selected_ref,)
        )

        assert surrogate.calls == 2
        assert telemetry.payloads("attention.decision") == (
            {
                "channel": "codex",
                "memory_ref": silent_ref,
                "speak": False,
                "selected": False,
            },
            {
                "channel": "codex",
                "memory_ref": selected_ref,
                "speak": True,
                "selected": True,
            },
        )
        assert [queued.intent.item.event_id for queued in service._host_items] == [
            f"suggestion:{selected.id}"
        ]
        assert service._host_items[0].intent.item.kind == "progress"
        assert service._host_items[0].intent.item.content == MILESTONE_SUMMARY
        assert runtime.memory.channels["codex"].items[0].ref == silent_ref
        assert runtime.memory.channels["codex"].items[0].content["summary"] == SILENT_SUMMARY
        assert silent.status == "withdrawn"
        assert selected.status == "pending"

        await service.flush_host_items()
        assert [item.event_id for item in provider.injected] == [f"suggestion:{selected.id}"]
        await service.handle_event(
            ResponseStarted(session_epoch=1, response_id="selected-response")
        )
        await service.handle_event(
            ResponseAudioDelta(
                session_epoch=1,
                response_id="selected-response",
                pcm=b"\x00\x01",
            )
        )
        generation = service.session.current_generation
        assert generation is not None
        assert service.playback_started(
            generation.utterance_id,
            generation.generation_epoch,
        )
        await service.handle_event(
            ResponseTranscriptFinal(
                session_epoch=1,
                response_id="selected-response",
                text="自动保存和刷新恢复已完成，测试全部通过。",
            )
        )
        await service.handle_event(
            ResponseTerminal(
                session_epoch=1,
                response_id="selected-response",
                status="completed",
                reason="completed",
            )
        )
        assert service.playback_done(generation.utterance_id, generation.generation_epoch)
        assert runtime.suggestions.get(selected.id).status == "fired"  # type: ignore[union-attr]
        assert runtime.suggestions.get(silent.id).status == "withdrawn"  # type: ignore[union-attr]
    finally:
        stop.set()
        await runner
        await service.close()


@pytest.mark.asyncio
async def test_policy_enabled_progress_has_no_direct_host_projection() -> None:
    host_event_ids = await _progress_host_event_ids()

    assert host_event_ids == ()


@pytest.mark.asyncio
async def test_silent_progress_memory_remains_recallable() -> None:
    evidence = await _exercise_silent_recall()

    assert evidence.recall.payload["hits"][0]["ref"] == evidence.attention[0]["memory_ref"]
    assert evidence.recall.payload["hits"][0]["evidence"] == SILENT_SUMMARY


@pytest.mark.asyncio
async def test_accepting_unoffered_progress_breaks_exact_trigger_gate() -> None:
    host_event_ids = await _progress_host_event_ids(decision="unoffered")

    assert host_event_ids == ()


@pytest.mark.asyncio
async def test_historical_recall_uses_memory_without_codex_status_or_run() -> None:
    evidence = await _exercise_silent_recall()

    assert evidence.admissions == ({"logical_name": "memory.recall", "outcome": "inline"},)
    assert not [
        admission
        for admission in evidence.admissions
        if admission["logical_name"] in {"codex.status", "codex.run"}
    ]
    assert evidence.delegates_after_recall == evidence.delegates_before_recall
