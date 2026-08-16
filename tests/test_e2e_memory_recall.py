from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from itertools import count
from typing import Any

import pytest

from nova_audio_agent.clock import RealClock
from nova_audio_agent.executors.codex_live import CODEX_LIVE_MANIFEST
from nova_audio_agent.executors.watcher import WATCH_MANIFEST
from nova_audio_agent.events import HandoffEvent, ModelDone
from nova_audio_agent.memory import (
    CONVERSATION_CHANNEL,
    USER_PRIORITY,
    Memory,
    MemoryItem,
    StructuredState,
)
from nova_audio_agent.ports import Delegate, ExecutorManifest, SurrogateOutput
from nova_audio_agent.realtime.bridge import RealtimeRuntimeBridge
from nova_audio_agent.realtime.evidence import safe_memory_evidence
from nova_audio_agent.realtime.playback import PlaybackRegistry
from nova_audio_agent.realtime.protocol import (
    HostContextItem,
    HostResponseIntent,
    ItemIdentity,
    RealtimeFrontBrainEvent,
    ResponseStarted,
    ResponseTerminal,
    SessionIdentity,
    ToolCallReady,
    UserSpeechEnded,
    UserSpeechStarted,
    UserTranscriptFinal,
)
from nova_audio_agent.realtime.service import RealtimeService
from nova_audio_agent.realtime.session import RealtimeSession
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.tool_schema import compile_tool_schema


class RecallProvider:
    def __init__(self) -> None:
        self.epoch = 0
        self.injected: list[HostContextItem] = []
        self.response_intents: list[HostResponseIntent] = []

    async def connect(self, *, tools: tuple[dict[str, Any], ...]) -> SessionIdentity:
        assert any(tool["function"]["name"] == "memory__recall" for tool in tools)
        self.epoch += 1
        return SessionIdentity(self.epoch, f"session-{self.epoch}")

    async def send_audio(self, pcm: bytes) -> None:
        del pcm

    async def inject_host_item(self, item: HostContextItem) -> ItemIdentity:
        self.injected.append(item)
        return ItemIdentity(self.epoch, item.host_item_id, f"provider-{item.host_item_id}")

    async def create_response(self, intent: HostResponseIntent) -> None:
        self.response_intents.append(intent)

    async def cancel_response(self, response_id: str) -> None:
        del response_id

    async def close(self) -> None:
        return None

    async def events(self) -> AsyncIterator[RealtimeFrontBrainEvent]:
        if False:
            yield ResponseStarted(session_epoch=1, response_id="unused")


class _SilentSurrogate:
    def __init__(self) -> None:
        self.called = asyncio.Event()

    async def watch(self, _view: object) -> SurrogateOutput:
        self.called.set()
        return SurrogateOutput(speak=False, reason="记录但不主动打扰")


def _codex_memory_item(content: dict[str, object]) -> MemoryItem:
    return MemoryItem(
        channel="codex",
        seq=1,
        ts=1.0,
        trust="trusted_system",
        priority=50,
        content=content,
    )


def test_safe_codex_progress_evidence_is_only_its_validated_summary() -> None:
    item = _codex_memory_item(
        {
            "op": "run",
            "phase": "working",
            "internal_activity": 1,
            "elapsed": 4.0,
            "summary": "旧版只把笔记保存在页面内存中，刷新会丢失",
        }
    )

    assert safe_memory_evidence(item) == "旧版只把笔记保存在页面内存中，刷新会丢失"


@pytest.mark.parametrize(
    "content",
    (
        {"summary": "未标记为进度的内容"},
        {"phase": "working", "summary": "控制\x07字符"},
        {"phase": "working", "summary": "x" * 401},
        {"phase": "started", "summary": "started 不应携带摘要"},
    ),
)
def test_malformed_or_unrelated_codex_content_keeps_terminal_fallback(
    content: dict[str, object],
) -> None:
    assert safe_memory_evidence(_codex_memory_item(content)) == (
        "Codex 任务未能确认完成（no_final_message）"
    )


def test_codex_terminal_final_message_evidence_is_unchanged() -> None:
    item = _codex_memory_item(
        {
            "result": {
                "final_message": {
                    "text": "已完成 memory recall 主体并通过测试",
                    "truncated": False,
                }
            }
        }
    )

    assert safe_memory_evidence(item) == (
        "Codex 任务结果不确定：已完成 memory recall 主体并通过测试"
    )


ChannelSnapshot = tuple[tuple[str, tuple[object, ...], str | None, int], ...]


@dataclass(frozen=True, slots=True)
class MemorySnapshot:
    channels: ChannelSnapshot
    structured: StructuredState


@dataclass(frozen=True, slots=True)
class HistoricalRecallResult:
    payload: dict[str, object]
    before_inline_memory: MemorySnapshot
    after_inline_memory: MemorySnapshot


def snapshot_memory(memory: Memory) -> MemorySnapshot:
    return MemorySnapshot(
        channels=tuple(
            (name, tuple(board.items), board.summary, board.uncompressed)
            for name, board in sorted(memory.channels.items())
        ),
        structured=memory.structured,
    )


def build_memory_recall_service(
    runtime: Runtime,
    *,
    manifests: tuple[ExecutorManifest, ...] = (),
    telemetry: object | None = None,
) -> tuple[RealtimeService, RecallProvider]:
    provider = RecallProvider()
    serial = count(1)

    def next_id() -> str:
        return f"recall-{next(serial)}"

    tools = compile_tool_schema(manifests, include_memory_recall=True)
    playback = PlaybackRegistry(
        id_factory=next_id,
        on_frame=lambda _frame: None,
        on_clear=lambda _utterance_id, _epoch: None,
    )
    session = RealtimeSession(
        provider=provider,
        playback=playback,
        id_factory=next_id,
        on_spoken=lambda _text: None,
        on_delivery=lambda _completion: None,
        clock=runtime.clock,
    )
    bridge = RealtimeRuntimeBridge(runtime=runtime, tools=tools, id_factory=next_id)
    return (
        RealtimeService(
            provider=provider,
            runtime=runtime,
            tools=tools,
            session=session,
            bridge=bridge,
            id_factory=next_id,
            telemetry=telemetry,  # type: ignore[arg-type]
        ),
        provider,
    )


async def historical_recall_turn(
    service: RealtimeService,
    *,
    query: str,
) -> HistoricalRecallResult:
    provider = service._provider
    assert isinstance(provider, RecallProvider)
    epoch = service.session.session_epoch
    assert epoch is not None
    turn_number = len(service._runtime.memory.channels[CONVERSATION_CHANNEL].items) + 1
    speech_id = f"speech-{turn_number}"
    user_item_id = f"user-item-{turn_number}"
    response_id = f"origin-response-{turn_number}"
    call_id = f"call-recall-{turn_number}"
    await service.handle_event(
        UserSpeechStarted(
            session_epoch=epoch,
            speech_id=speech_id,
            provider_item_id=user_item_id,
        )
    )
    await service.handle_event(UserSpeechEnded(session_epoch=epoch, speech_id=speech_id))
    await service.handle_event(
        UserTranscriptFinal(session_epoch=epoch, item_id=user_item_id, text=query)
    )
    before = snapshot_memory(service._runtime.memory)
    await service.handle_event(ResponseStarted(session_epoch=epoch, response_id=response_id))
    await service.handle_event(
        ToolCallReady(
            session_epoch=epoch,
            call_id=call_id,
            item_id=f"tool-item-{turn_number}",
            name="memory__recall",
            arguments={"query": query, "scope": "recent"},
            response_id=response_id,
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=epoch,
            response_id=response_id,
            status="completed",
            reason="completed",
        )
    )
    payload = json.loads(provider.response_intents[-1].item.content)
    return HistoricalRecallResult(
        payload=payload,
        before_inline_memory=before,
        after_inline_memory=snapshot_memory(service._runtime.memory),
    )


async def _recall_turn(
    runtime: Runtime,
    *,
    query: str,
) -> tuple[dict[str, object], dict[str, tuple[object, ...]], RecallProvider, RealtimeService]:
    service, provider = build_memory_recall_service(runtime)
    await service.connect()
    stop = asyncio.Event()
    runner = asyncio.create_task(runtime.serve(stop))
    try:
        assert provider.injected == []
        result = await historical_recall_turn(service, query=query)
        before = {
            channel: items
            for channel, items, _summary, _uncompressed in result.before_inline_memory.channels
        }
        return result.payload, before, provider, service
    finally:
        stop.set()
        await runner


@pytest.mark.asyncio
async def test_completed_codex_fact_only_in_memory_grounds_realtime_continuation() -> None:
    memory = Memory(policies=(CODEX_LIVE_MANIFEST.policy,))
    memory.append(
        "codex",
        ts=1.0,
        trust="untrusted_external",
        priority=50,
        outcome="ok",
        content={
            "result": {
                "final_message": {
                    "text": "已完成 memory recall 主体并通过测试",
                    "truncated": False,
                }
            }
        },
    )
    runtime = Runtime(clock=RealClock(), memory=memory)

    payload, before, provider, service = await _recall_turn(
        runtime,
        query="那个 codex 任务后来怎么样了",
    )

    assert payload["hits"][0]["ref"] == "codex:1"
    assert "已完成 memory recall 主体并通过测试" in payload["hits"][0]["evidence"]
    assert all(hit["ref"] != "conversation:1" for hit in payload["hits"])
    assert provider.injected[-1].kind == "tool_output"
    assert provider.response_intents[-1].kind == "tool_result"
    assert {channel: tuple(board.items) for channel, board in memory.channels.items()} == before
    assert service._pending_sync == {}


@pytest.mark.asyncio
async def test_unspoken_watch_hit_remains_recallable_without_becoming_host_fact() -> None:
    memory = Memory(policies=(WATCH_MANIFEST.policy,))
    origin = memory.append(
        CONVERSATION_CHANNEL,
        ts=0.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "看到水杯时只记录，不要主动说"},
    )
    selected: list[object] = []
    surrogate = _SilentSurrogate()
    runtime = Runtime(
        clock=RealClock(),
        memory=memory,
        surrogate=surrogate,
        on_suggestion_selected=lambda suggestion, _reason: selected.append(suggestion),
    )
    runtime.delegates.dispatch(
        Delegate(
            delegate_id="d-watch",
            executor="watch",
            op="start",
            request={"condition": "出现水杯"},
            origin_ref=origin.ref,
            deadline=300.0,
            routing_class="ambient",
            dispatched_at=0.0,
        )
    )
    runtime.post(
        HandoffEvent(
            channel="watch",
            delegate_id="d-watch",
            origin_ref=origin.ref,
            outcome="ok",
            trust="untrusted_external",
            content={
                "hit": True,
                "condition": "出现水杯",
                "observation": "桌面上出现蓝色水杯",
                "media_ref": "private-media",
            },
        )
    )
    stop = asyncio.Event()
    runner = asyncio.create_task(runtime.serve(stop))
    await asyncio.wait_for(surrogate.called.wait(), timeout=1.0)
    while not any(isinstance(event, ModelDone) for event in runtime.applied):
        await asyncio.sleep(0)
    stop.set()
    await runner

    suggestion = runtime.suggestions.get("s-1")
    assert suggestion is not None
    assert suggestion.evidence_refs == ("watch:1",)
    assert selected == []

    payload, before, provider, service = await _recall_turn(
        runtime,
        query="刚才那个蓝色水杯是什么",
    )

    assert payload["hits"][0]["ref"] == "watch:1"
    assert "桌面上出现蓝色水杯" in payload["hits"][0]["evidence"]
    assert "private-media" not in json.dumps(payload, ensure_ascii=False)
    assert all(hit["ref"] != "conversation:2" for hit in payload["hits"])
    assert runtime.suggestions.get(suggestion.id) == suggestion
    assert all(item.kind == "tool_output" for item in provider.injected)
    assert service._host_items == []
    assert {channel: tuple(board.items) for channel, board in memory.channels.items()} == before
