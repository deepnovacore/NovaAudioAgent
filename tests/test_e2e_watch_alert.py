from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from dataclasses import asdict, dataclass
from itertools import count
from pathlib import Path
from types import SimpleNamespace

import pytest

from nova_audio_agent.evals import watch_alert as watch_alert_eval
from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.evals.watch_alert import (
    GATES,
    SCENARIO_ID,
    WatchAlertRecorder,
    evaluate_watch_alert,
)
from nova_audio_agent.events import HandoffEvent, ObservationEvent
from nova_audio_agent.executors.camera import Frame
from nova_audio_agent.executors.watcher import GUARD_MANIFEST, WATCH_MANIFEST, WatchAdapter
from nova_audio_agent.media import MediaStore
from nova_audio_agent.memory import CONVERSATION_CHANNEL, USER_PRIORITY, Memory
from nova_audio_agent.model_gateway import GatewayCompletion, GatewayImage
from nova_audio_agent.ports import Delegate, ExecutorManifest
from nova_audio_agent.realtime.bridge import RealtimeRuntimeBridge
from nova_audio_agent.realtime.playback import PlaybackCompletion, PlaybackFrame, PlaybackRegistry
from nova_audio_agent.realtime.memory_board import memory_board_message
from nova_audio_agent.realtime.protocol import (
    HostContextItem,
    HostResponseIntent,
    ItemIdentity,
    RealtimeFrontBrainEvent,
    ResponseAudioDelta,
    ResponseStarted,
    ResponseTerminal,
    ResponseTranscriptFinal,
    SessionIdentity,
    ToolCallReady,
    UserSpeechStarted,
)
from nova_audio_agent.realtime.service import RealtimeService
from nova_audio_agent.realtime.session import RealtimeSession
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.tool_schema import compile_tool_schema
from scripts import eval_watch_alert as live_watch


def _record(index: int, kind: str, data: dict[str, object], *, t_ms: float) -> dict[str, object]:
    return {"event_ref": f"e{index:03d}", "t_ms": t_ms, "kind": kind, "data": data}


class _Frames:
    def __init__(self, frame: Frame) -> None:
        self.frame = frame
        self.snapshots = 0

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None

    async def snapshot(self) -> Frame:
        self.snapshots += 1
        return self.frame


class _BlockingHitGateway:
    def __init__(self, recorder: WatchAlertRecorder) -> None:
        self.recorder = recorder
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.delegate_id: str | None = None
        self.calls = 0

    async def complete(
        self,
        *,
        model: str,
        system: str,
        prompt: str,
        json_schema: dict[str, object] | None = None,
        images: Sequence[GatewayImage] = (),
    ) -> GatewayCompletion:
        del model, system, json_schema
        self.calls += 1
        self.started.set()
        await self.release.wait()
        image = images[0]
        observation = "桌面上出现水杯"
        self.recorder.record(
            "vision.verdict",
            {
                "delegate_id": self.delegate_id or "pending",
                "frame_digest": hashlib.sha256(image.payload).hexdigest(),
                "hit": True,
                "condition": prompt.removeprefix("监控条件："),
                "observation": observation,
            },
        )
        return GatewayCompletion(
            json.dumps({"hit": True, "observation": observation}, ensure_ascii=False)
        )


class _RepeatRecordingGateway:
    def __init__(self, recorder: WatchAlertRecorder) -> None:
        self.recorder = recorder
        self.delegate_id: str | None = None
        self.calls = 0
        self._verdicts = iter(
            (
                (False, ""),
                (True, "画面中出现白纸"),
                (True, "白纸仍然可见"),
                (True, "白纸仍然可见"),
                (False, ""),
                (False, ""),
                (True, "白纸再次出现"),
            )
        )

    async def complete(
        self,
        *,
        model: str,
        system: str,
        prompt: str,
        json_schema: dict[str, object] | None = None,
        images: Sequence[GatewayImage] = (),
    ) -> GatewayCompletion:
        del model, system, json_schema
        self.calls += 1
        hit, observation = next(self._verdicts)
        image = images[0]
        self.recorder.record(
            "vision.verdict",
            {
                "delegate_id": self.delegate_id or "pending",
                "frame_digest": hashlib.sha256(image.payload + bytes([self.calls])).hexdigest(),
                "hit": hit,
                "condition": prompt.removeprefix("监控条件："),
                "observation": observation,
            },
        )
        return GatewayCompletion(
            json.dumps({"hit": hit, "observation": observation}, ensure_ascii=False)
        )


class _Provider:
    def __init__(self) -> None:
        self.epoch = 0
        self.injected: list[HostContextItem] = []
        self.response_intents: list[HostResponseIntent] = []
        self.actions: list[str] = []

    async def connect(self, *, tools: tuple[dict[str, object], ...]) -> SessionIdentity:
        self.epoch += 1
        return SessionIdentity(self.epoch, f"session-{self.epoch}")

    async def send_audio(self, pcm: bytes) -> None:
        return None

    async def inject_host_item(self, item: HostContextItem) -> ItemIdentity:
        self.injected.append(item)
        return ItemIdentity(self.epoch, item.host_item_id, f"provider-{item.host_item_id}")

    async def create_response(self, intent: HostResponseIntent) -> None:
        self.response_intents.append(intent)

    async def cancel_response(self, response_id: str) -> None:
        self.actions.append(f"cancel:{response_id}")

    async def close(self) -> None:
        return None

    async def events(self) -> AsyncIterator[RealtimeFrontBrainEvent]:
        if False:
            yield ResponseStarted(session_epoch=1, response_id="unused")


@dataclass(slots=True)
class _ServiceStack:
    runtime: Runtime
    service: RealtimeService
    provider: _Provider
    frames: list[PlaybackFrame]


@dataclass(frozen=True, slots=True)
class _WatchScenarioRun:
    records: tuple[Mapping[str, object], ...]
    gateway_calls: int
    guard_terminated_by: str | None
    assistant_cancellations: tuple[str, ...]
    delivery_count: int


def _watch_adapter(
    manifest: ExecutorManifest,
    *,
    source: _Frames,
    gateway: _BlockingHitGateway,
) -> WatchAdapter:
    return WatchAdapter(
        manifest,
        source,
        gateway,
        MediaStore(id_factory=lambda: manifest.name),
        model="watch-vl",
        capture_enabled=True,
    )


def _build_service_stack(
    recorder: WatchAlertRecorder,
    *,
    delivery_delegate_id: str | None = None,
) -> _ServiceStack:
    clock = VirtualClock()
    source = _Frames(
        Frame(
            payload=b"unused-frame",
            media_type="image/jpeg",
            width=640,
            height=480,
            captured_at=0.0,
        )
    )
    gateway = _BlockingHitGateway(recorder)
    executors = {
        "watch": _watch_adapter(WATCH_MANIFEST, source=source, gateway=gateway),
        "guard": _watch_adapter(GUARD_MANIFEST, source=source, gateway=gateway),
    }
    memory = Memory(policies=(WATCH_MANIFEST.policy, GUARD_MANIFEST.policy))
    runtime = Runtime(
        clock=clock,
        memory=memory,
        executors=executors,
        expected_active_executors=frozenset(),
    )
    tools = compile_tool_schema((WATCH_MANIFEST, GUARD_MANIFEST))
    serial = count(1)
    next_id = lambda: f"watch-e2e-{next(serial)}"  # noqa: E731 - deterministic id factory
    provider = _Provider()
    frames: list[PlaybackFrame] = []
    playback = PlaybackRegistry(
        id_factory=next_id,
        on_frame=frames.append,
        on_clear=lambda utterance_id, generation_epoch: None,
    )

    def on_delivery(completion: PlaybackCompletion) -> None:
        if delivery_delegate_id is None or "桌面上出现水杯" not in completion.text:
            return
        recorder.record(
            "playback.delivered",
            {"delegate_id": delivery_delegate_id, "transcript": completion.text},
        )

    session = RealtimeSession(
        provider=provider,
        playback=playback,
        id_factory=next_id,
        on_delivery=on_delivery,
        clock=clock,
    )
    bridge = RealtimeRuntimeBridge(runtime=runtime, tools=tools, id_factory=next_id)
    service = RealtimeService(
        provider=provider,
        runtime=runtime,
        tools=tools,
        session=session,
        bridge=bridge,
        id_factory=next_id,
    )
    return _ServiceStack(runtime=runtime, service=service, provider=provider, frames=frames)


def _bind_watch_delegate(runtime: Runtime, delegate_id: str, executor: str) -> None:
    runtime.delegates.dispatch(
        Delegate(
            delegate_id=delegate_id,
            executor=executor,
            op="start",
            request={"condition": "水杯"},
            origin_ref="conversation:1",
            deadline=30.0,
            routing_class="user_awaited",
            dispatched_at=0.0,
        )
    )


def _hit_event(executor: str, delegate_id: str) -> HandoffEvent:
    return HandoffEvent(
        channel=executor,
        delegate_id=delegate_id,
        origin_ref="conversation:1",
        outcome="ok",
        trust="untrusted_external",
        content={
            "hit": True,
            "condition": "水杯",
            "observation": "桌面上出现水杯",
            "media_ref": f"media:{executor}",
        },
    )


async def _drive_adapter_path(
    recorder: WatchAlertRecorder,
    clock: VirtualClock,
) -> tuple[int, str | None, str]:
    source = _Frames(
        Frame(
            payload=b"guard-frame",
            media_type="image/jpeg",
            width=640,
            height=480,
            captured_at=clock.now(),
        )
    )
    gateway = _BlockingHitGateway(recorder)
    guard = _watch_adapter(GUARD_MANIFEST, source=source, gateway=gateway)
    memory = Memory(policies=(GUARD_MANIFEST.policy,))
    origin = memory.append(
        CONVERSATION_CHANNEL,
        ts=clock.now(),
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "看到水杯就提醒我"},
    )
    runtime = Runtime(
        clock=clock,
        memory=memory,
        executors={"guard": guard},
        expected_active_executors=frozenset(),
    )
    tools = compile_tool_schema((GUARD_MANIFEST,))
    identifiers = count(1)
    next_id = lambda: f"bridge-{next(identifiers)}"  # noqa: E731 - deterministic id factory
    bridge = RealtimeRuntimeBridge(
        runtime=runtime,
        tools=tools,
        id_factory=next_id,
    )
    start_delegate_id: str | None = None
    status_delegate_id: str | None = None
    provider = _Provider()
    playback = PlaybackRegistry(
        id_factory=next_id,
        on_frame=lambda frame: None,
        on_clear=lambda utterance_id, generation_epoch: None,
    )

    def on_delivery(completion: PlaybackCompletion) -> None:
        if start_delegate_id is None:
            return
        recorder.record(
            "dispatch.spoken",
            {"delegate_id": start_delegate_id, "transcript": completion.text},
        )

    session = RealtimeSession(
        provider=provider,
        playback=playback,
        id_factory=next_id,
        on_delivery=on_delivery,
        clock=clock,
    )
    service = RealtimeService(
        provider=provider,
        runtime=runtime,
        tools=tools,
        session=session,
        bridge=bridge,
        id_factory=next_id,
    )

    def observe(event: object) -> None:
        if isinstance(event, ObservationEvent) and event.delegate_id == start_delegate_id:
            content = event.content if isinstance(event.content, Mapping) else {}
            if content.get("hit") is True:
                recorder.record(
                    "watch.observation",
                    {
                        "delegate_id": event.delegate_id,
                        "executor": event.channel,
                        "event_id": f"observation:{event.delegate_id}:{event.seq}",
                        "hit": True,
                    },
                )
            return
        if not isinstance(event, HandoffEvent):
            return
        if event.delegate_id == start_delegate_id:
            content = event.content if isinstance(event.content, Mapping) else {}
            recorder.record(
                "watch.handoff",
                {
                    "delegate_id": event.delegate_id,
                    "executor": event.channel,
                    "hit": content.get("hit"),
                    "outcome": event.outcome,
                    "state": content.get("state"),
                },
            )
        elif event.delegate_id == status_delegate_id:
            content = event.content if isinstance(event.content, Mapping) else {}
            recorder.record(
                "status.sync",
                {
                    "executor": event.channel,
                    "sync_result": True,
                    "state": content.get("state"),
                },
            )

    runtime.observe(observe)
    await service.connect()
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-guard-start",
            item_id="item-guard-start",
            name="guard__start",
            arguments={
                "condition": "水杯",
                "interval_s": 5,
                "duration_s": 60,
                "origin_ref": origin.ref,
            },
            response_id="origin-response",
        )
    )
    start_state = service._tool_call_state((1, "call-guard-start"))
    assert start_state is not None
    start = start_state.acceptance
    assert start.accepted and start.delegate_id is not None
    start_delegate_id = start.delegate_id
    gateway.delegate_id = start_delegate_id
    recorder.record(
        "dispatch.ack",
        {"executor": start.executor or "", "delegate_id": start_delegate_id},
    )
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="dispatch-ack"))
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="dispatch-ack",
            pcm=b"\x00\x01",
        )
    )
    acknowledgement_generation = service.session.current_generation
    assert acknowledgement_generation is not None
    assert service.playback_started(
        acknowledgement_generation.utterance_id,
        acknowledgement_generation.generation_epoch,
    )
    await service.handle_event(
        ResponseTranscriptFinal(
            session_epoch=1,
            response_id="dispatch-ack",
            text="已经开始监控水杯",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="dispatch-ack",
            status="completed",
            reason="completed",
        )
    )
    assert service.playback_done(
        acknowledgement_generation.utterance_id,
        acknowledgement_generation.generation_epoch,
    )
    for _ in range(10):
        await asyncio.sleep(0)
        if gateway.started.is_set():
            break
    assert gateway.started.is_set()

    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-guard-status",
            item_id="item-guard-status",
            name="guard__status",
            arguments={"origin_ref": origin.ref},
            response_id="origin-response",
        )
    )
    status_state = service._tool_call_state((1, "call-guard-status"))
    assert status_state is not None
    status = status_state.acceptance
    assert status.accepted and status.delegate_id is not None and status.sync_result
    status_delegate_id = status.delegate_id
    for _ in range(20):
        await asyncio.sleep(0)
        while event := runtime.queue.pop_ready(clock.now()):
            runtime._process_event(event, reclaim=False)
        if any(record["kind"] == "status.sync" for record in recorder.records):
            break
    assert any(record["kind"] == "status.sync" for record in recorder.records)
    gateway.release.set()
    for _ in range(40):
        await asyncio.sleep(0)
        while event := runtime.queue.pop_ready(clock.now()):
            runtime._process_event(event, reclaim=False)
        if any(record["kind"] == "watch.observation" for record in recorder.records):
            break
    assert any(record["kind"] == "watch.observation" for record in recorder.records)

    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-guard-stop",
            item_id="item-guard-stop",
            name="guard__stop",
            arguments={"origin_ref": origin.ref},
            response_id="origin-response",
        )
    )
    for _ in range(40):
        await asyncio.sleep(0)
        while event := runtime.queue.pop_ready(clock.now()):
            runtime._process_event(event, reclaim=False)
        if runtime.delegates.terminated_by(start_delegate_id) == "handoff":
            break
    runtime._reap()
    while event := runtime.queue.pop_ready(clock.now()):
        runtime._process_event(event, reclaim=False)

    await service.close()
    return gateway.calls, runtime.delegates.terminated_by(start_delegate_id), start_delegate_id


async def _drain_repeat_runtime(
    runtime: Runtime,
    clock: VirtualClock,
    *,
    predicate: Callable[[], bool],
) -> None:
    for _ in range(1000):
        await asyncio.sleep(0)
        while event := runtime.queue.pop_ready(clock.now()):
            runtime._process_event(event, reclaim=False)
        if predicate():
            return
        next_ts = clock.next_timer_ts()
        if next_ts is not None:
            clock.advance_to(next_ts)
    raise AssertionError("repeat runtime did not reach the expected state")


async def _drive_repeat_production_scenario() -> tuple[tuple[Mapping[str, object], ...], str]:
    clock = VirtualClock()
    recorder = WatchAlertRecorder(clock=clock)
    source = _Frames(
        Frame(
            payload=b"repeat-frame",
            media_type="image/jpeg",
            width=640,
            height=480,
            captured_at=0.0,
        )
    )
    gateway = _RepeatRecordingGateway(recorder)
    media_ids = iter(("repeat-first", "repeat-second"))
    guard = WatchAdapter(
        GUARD_MANIFEST,
        source,
        gateway,
        MediaStore(id_factory=lambda: next(media_ids)),
        model="watch-vl",
        capture_enabled=True,
    )
    memory = Memory(policies=(GUARD_MANIFEST.policy,))
    origin = memory.append(
        CONVERSATION_CHANNEL,
        ts=0.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "看到白纸就提醒我"},
    )
    runtime = Runtime(
        clock=clock,
        memory=memory,
        executors={"guard": guard},
        expected_active_executors=frozenset(),
    )
    tools = compile_tool_schema((GUARD_MANIFEST,))
    serial = count(1)
    next_id = lambda: f"repeat-{next(serial)}"  # noqa: E731 - deterministic id factory
    provider = _Provider()
    playback = PlaybackRegistry(
        id_factory=next_id,
        on_frame=lambda frame: None,
        on_clear=lambda utterance_id, generation_epoch: None,
    )
    service: RealtimeService | None = None
    delivery_event_ids: dict[str, str] = {}

    def on_delivery(completion: PlaybackCompletion) -> None:
        assert service is not None
        event_id = delivery_event_ids.get(completion.response_id)
        if event_id is None:
            return
        recorder.record(
            "playback.delivered",
            {
                "delegate_id": gateway.delegate_id or "pending",
                "event_id": event_id,
                "transcript": completion.text,
            },
        )

    session = RealtimeSession(
        provider=provider,
        playback=playback,
        id_factory=next_id,
        on_delivery=on_delivery,
        clock=clock,
    )
    bridge = RealtimeRuntimeBridge(runtime=runtime, tools=tools, id_factory=next_id)
    service = RealtimeService(
        provider=provider,
        runtime=runtime,
        tools=tools,
        session=session,
        bridge=bridge,
        id_factory=next_id,
    )
    start_delegate_id: str | None = None
    handoff_results: dict[str, tuple[str, Mapping[str, object]]] = {}

    def observe(event: object) -> None:
        if isinstance(event, ObservationEvent) and event.delegate_id == start_delegate_id:
            content = event.content if isinstance(event.content, Mapping) else {}
            recorder.record(
                "watch.observation",
                {
                    "delegate_id": event.delegate_id,
                    "executor": event.channel,
                    "event_id": (
                        f"observation:{event.delegate_id}:{event.seq}"
                        if content.get("hit") is True
                        else ""
                    ),
                    "hit": content.get("hit") is True,
                    "state": content.get("state"),
                    "hit_count": content.get("hit_count"),
                    "reset_count": content.get("reset_count"),
                },
            )
        elif isinstance(event, HandoffEvent) and event.delegate_id == start_delegate_id:
            handoff_results[event.delegate_id] = (event.outcome, event.content)
            recorder.record(
                "watch.handoff",
                {
                    "delegate_id": event.delegate_id,
                    "executor": event.channel,
                    "hit": event.content.get("hit"),
                    "outcome": event.outcome,
                    "state": event.content.get("state"),
                },
            )

    runtime.observe(observe)
    await service.connect()
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="repeat-start",
            item_id="repeat-start-item",
            name="guard__start",
            arguments={
                "condition": "白纸",
                "interval_s": 2,
                "duration_s": 60,
                "origin_ref": origin.ref,
            },
            response_id="repeat-origin",
        )
    )
    start_state = service._tool_call_state((1, "repeat-start"))
    assert start_state is not None
    start = start_state.acceptance
    assert start.accepted and start.delegate_id is not None
    start_delegate_id = start.delegate_id
    gateway.delegate_id = start_delegate_id
    recorder.record("dispatch.ack", {"executor": "guard", "delegate_id": start_delegate_id})
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="repeat-dispatch-ack"))
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="repeat-dispatch-ack",
            pcm=b"\x00\x01",
        )
    )
    acknowledgement_generation = service.session.current_generation
    assert acknowledgement_generation is not None
    assert service.playback_started(
        acknowledgement_generation.utterance_id,
        acknowledgement_generation.generation_epoch,
    )
    await service.handle_event(
        ResponseTranscriptFinal(
            session_epoch=1,
            response_id="repeat-dispatch-ack",
            text="已经开始监控白纸",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="repeat-dispatch-ack",
            status="completed",
            reason="completed",
        )
    )
    assert service.playback_done(
        acknowledgement_generation.utterance_id,
        acknowledgement_generation.generation_epoch,
    )

    delivered_hits = 0
    while gateway.calls < 7:
        target_calls = gateway.calls + 1
        await _drain_repeat_runtime(
            runtime,
            clock,
            predicate=lambda: gateway.calls >= target_calls,
        )
        await _drain_repeat_runtime(
            runtime,
            clock,
            predicate=lambda: (
                len(
                    [
                        record
                        for record in recorder.records
                        if record["kind"] == "watch.observation"
                        and record["data"].get("state") in {"armed", "cooling", "waiting_reset"}
                    ]
                )
                >= 1
            ),
        )
        observed_hits = sum(
            record["kind"] == "watch.observation" and record["data"].get("hit") is True
            for record in recorder.records
        )
        if observed_hits <= delivered_hits:
            continue
        await service.flush_host_items()
        response_id = f"repeat-hit-response-{observed_hits}"
        await service.handle_event(ResponseStarted(session_epoch=1, response_id=response_id))
        delivery_event_ids[response_id] = next(
            event_id
            for event_id in service.session.response_event_ids(response_id)
            if event_id.startswith("observation:")
        )
        await service.handle_event(
            ResponseAudioDelta(session_epoch=1, response_id=response_id, pcm=b"\x00\x01")
        )
        generation = service.session.current_generation
        assert generation is not None
        assert service.playback_started(generation.utterance_id, generation.generation_epoch)
        transcript = "检测到画面中出现白纸" if observed_hits == 1 else "检测到白纸再次出现"
        await service.handle_event(
            ResponseTranscriptFinal(session_epoch=1, response_id=response_id, text=transcript)
        )
        await service.handle_event(
            ResponseTerminal(
                session_epoch=1,
                response_id=response_id,
                status="completed",
                reason="completed",
            )
        )
        assert service.playback_done(generation.utterance_id, generation.generation_epoch)
        delivered_hits = observed_hits

    assert delivered_hits == 2
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="repeat-stop",
            item_id="repeat-stop-item",
            name="guard__stop",
            arguments={"origin_ref": origin.ref},
            response_id="repeat-origin",
        )
    )
    stop_state = service._tool_call_state((1, "repeat-stop"))
    assert stop_state is not None
    stop = stop_state.acceptance
    assert stop.accepted and stop.delegate_id is not None

    def capture_stop(event: object) -> None:
        if isinstance(event, HandoffEvent) and event.delegate_id == stop.delegate_id:
            handoff_results[event.delegate_id] = (event.outcome, event.content)

    runtime.observe(capture_stop)
    await _drain_repeat_runtime(
        runtime,
        clock,
        predicate=lambda: runtime.delegates.terminated_by(start_delegate_id or "") == "handoff",
    )
    stop_outcome, stop_content = handoff_results[stop.delegate_id]
    start_outcome, start_content = handoff_results[start_delegate_id]
    recorder.record(
        "watch.stop",
        {
            "start_delegate_id": start_delegate_id,
            "stop_delegate_id": stop.delegate_id,
            "outcome": stop_outcome,
            "stopped": stop_content.get("stopped"),
            "start_state": start_content.get("state") if start_outcome == "ok" else "failed",
        },
    )
    board = memory_board_message("repeat-production", memory)
    await service.close()
    return recorder.records, board


async def _drive_guard_preemption_and_delivery(
    recorder: WatchAlertRecorder,
    *,
    delegate_id: str,
) -> tuple[str, ...]:
    stack = _build_service_stack(recorder, delivery_delegate_id=delegate_id)
    _bind_watch_delegate(stack.runtime, delegate_id, "guard")
    await stack.service.connect()
    await stack.service.handle_event(
        ResponseStarted(session_epoch=1, response_id="assistant-response")
    )
    await stack.service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="assistant-response",
            pcm=b"\x00\x01",
        )
    )
    generation = stack.service.session.current_generation
    assert generation is not None
    assert stack.service.playback_started(generation.utterance_id, generation.generation_epoch)

    stack.runtime._process_event(_hit_event("guard", delegate_id), reclaim=True)
    await stack.service.flush_host_items()
    cancelled = "cancel:assistant-response" in stack.provider.actions
    recorder.record(
        "preemption",
        {
            "executor": "guard",
            "hit": True,
            "assistant_cancelled": cancelled,
            "user_speaking": False,
        },
    )
    await stack.service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="assistant-response",
            status="cancelled",
            reason="guard_alert",
        )
    )
    assert stack.service.session.current_generation == generation

    await stack.service.handle_event(ResponseStarted(session_epoch=1, response_id="guard-response"))
    await stack.service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="guard-response",
            pcm=b"\x00\x01",
        )
    )
    assert stack.service.playback_cleared(
        generation.utterance_id,
        generation.generation_epoch,
    )
    guard_generation = stack.service.session.current_generation
    assert guard_generation is not None
    assert stack.service.playback_started(
        guard_generation.utterance_id, guard_generation.generation_epoch
    )
    transcript = "检测到桌面上出现水杯"
    await stack.service.handle_event(
        ResponseTranscriptFinal(
            session_epoch=1,
            response_id="guard-response",
            text=transcript,
        )
    )
    await stack.service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="guard-response",
            status="completed",
            reason="completed",
        )
    )
    assert stack.service.playback_done(
        guard_generation.utterance_id, guard_generation.generation_epoch
    )
    return tuple(
        action.removeprefix("cancel:")
        for action in stack.provider.actions
        if action.startswith("cancel:")
    )


async def _record_non_cancel_case(
    recorder: WatchAlertRecorder,
    *,
    executor: str,
    user_speaking: bool,
) -> None:
    delegate_id = f"d-{executor}-floor-{int(user_speaking)}"
    stack = _build_service_stack(recorder)
    _bind_watch_delegate(stack.runtime, delegate_id, executor)
    await stack.service.connect()
    if user_speaking:
        await stack.service.handle_event(
            UserSpeechStarted(
                session_epoch=1,
                speech_id="speech-1",
                provider_item_id="user-item-1",
            )
        )
    else:
        response_id = f"{executor}-assistant"
        await stack.service.handle_event(ResponseStarted(session_epoch=1, response_id=response_id))
        await stack.service.handle_event(
            ResponseAudioDelta(
                session_epoch=1,
                response_id=response_id,
                pcm=b"\x00\x01",
            )
        )
        generation = stack.service.session.current_generation
        assert generation is not None
        assert stack.service.playback_started(generation.utterance_id, generation.generation_epoch)
    stack.runtime._process_event(_hit_event(executor, delegate_id), reclaim=True)
    await stack.service.flush_host_items()
    cancelled = any(action.startswith("cancel:") for action in stack.provider.actions)
    recorder.record(
        "preemption",
        {
            "executor": executor,
            "hit": True,
            "assistant_cancelled": cancelled,
            "user_speaking": user_speaking,
        },
    )


async def _drive_production_scenario() -> _WatchScenarioRun:
    clock = VirtualClock()
    recorder = WatchAlertRecorder(clock=clock)
    gateway_calls, guard_terminated_by, guard_delegate_id = await _drive_adapter_path(
        recorder, clock
    )
    cancellations = await _drive_guard_preemption_and_delivery(
        recorder, delegate_id=guard_delegate_id
    )
    await _record_non_cancel_case(recorder, executor="watch", user_speaking=False)
    await _record_non_cancel_case(recorder, executor="guard", user_speaking=True)
    delivery_count = sum(record["kind"] == "playback.delivered" for record in recorder.records)
    return _WatchScenarioRun(
        records=recorder.records,
        gateway_calls=gateway_calls,
        guard_terminated_by=guard_terminated_by,
        assistant_cancellations=cancellations,
        delivery_count=delivery_count,
    )


def _complete_records() -> tuple[dict[str, object], ...]:
    return (
        _record(1, "dispatch.ack", {"executor": "guard", "delegate_id": "d-guard"}, t_ms=0),
        _record(
            9,
            "dispatch.spoken",
            {"delegate_id": "d-guard", "transcript": "已经开始监控水杯"},
            t_ms=1000,
        ),
        _record(
            2,
            "vision.verdict",
            {
                "delegate_id": "d-guard",
                "frame_digest": "a" * 64,
                "hit": True,
                "condition": "水杯",
                "observation": "桌面上出现水杯",
            },
            t_ms=5000,
        ),
        _record(
            3,
            "watch.handoff",
            {"delegate_id": "d-guard", "executor": "guard", "hit": True, "outcome": "ok"},
            t_ms=5001,
        ),
        _record(
            4,
            "preemption",
            {"executor": "guard", "hit": True, "assistant_cancelled": True, "user_speaking": False},
            t_ms=5002,
        ),
        _record(
            5,
            "preemption",
            {
                "executor": "watch",
                "hit": True,
                "assistant_cancelled": False,
                "user_speaking": False,
            },
            t_ms=5003,
        ),
        _record(
            6,
            "preemption",
            {"executor": "guard", "hit": True, "assistant_cancelled": False, "user_speaking": True},
            t_ms=5004,
        ),
        _record(
            7,
            "status.sync",
            {"executor": "guard", "sync_result": True, "state": "running"},
            t_ms=4000,
        ),
        _record(
            8,
            "playback.delivered",
            {"delegate_id": "d-guard", "transcript": "检测到桌面上出现水杯"},
            t_ms=6200,
        ),
    )


def _repeat_records() -> tuple[dict[str, object], ...]:
    return (
        _record(1, "dispatch.ack", {"executor": "guard", "delegate_id": "d-repeat"}, t_ms=0),
        _record(
            2,
            "watch.observation",
            {
                "delegate_id": "d-repeat",
                "executor": "guard",
                "state": "armed",
                "hit": False,
                "hit_count": 0,
            },
            t_ms=1,
        ),
        _record(
            3,
            "vision.verdict",
            {
                "delegate_id": "d-repeat",
                "frame_digest": "1" * 64,
                "hit": False,
                "condition": "白纸",
                "observation": "",
            },
            t_ms=1000,
        ),
        _record(
            4,
            "vision.verdict",
            {
                "delegate_id": "d-repeat",
                "frame_digest": "2" * 64,
                "hit": True,
                "condition": "白纸",
                "observation": "画面中出现白纸",
            },
            t_ms=2000,
        ),
        _record(
            5,
            "watch.observation",
            {
                "delegate_id": "d-repeat",
                "executor": "guard",
                "event_id": "observation:d-repeat:5",
                "state": "hit",
                "hit": True,
                "hit_count": 1,
            },
            t_ms=2001,
        ),
        _record(
            6,
            "watch.observation",
            {
                "delegate_id": "d-repeat",
                "executor": "guard",
                "state": "cooling",
                "hit": False,
                "hit_count": 1,
            },
            t_ms=2002,
        ),
        _record(
            7,
            "playback.delivered",
            {
                "delegate_id": "d-repeat",
                "event_id": "observation:d-repeat:5",
                "transcript": "检测到画面中出现白纸",
            },
            t_ms=2100,
        ),
        _record(
            8,
            "vision.verdict",
            {
                "delegate_id": "d-repeat",
                "frame_digest": "3" * 64,
                "hit": True,
                "condition": "白纸",
                "observation": "白纸仍然可见",
            },
            t_ms=3000,
        ),
        _record(
            9,
            "vision.verdict",
            {
                "delegate_id": "d-repeat",
                "frame_digest": "4" * 64,
                "hit": True,
                "condition": "白纸",
                "observation": "白纸仍然可见",
            },
            t_ms=4000,
        ),
        _record(
            10,
            "vision.verdict",
            {
                "delegate_id": "d-repeat",
                "frame_digest": "5" * 64,
                "hit": False,
                "condition": "白纸",
                "observation": "",
            },
            t_ms=5000,
        ),
        _record(
            11,
            "watch.observation",
            {
                "delegate_id": "d-repeat",
                "executor": "guard",
                "state": "waiting_reset",
                "hit": False,
                "hit_count": 1,
            },
            t_ms=5001,
        ),
        _record(
            12,
            "vision.verdict",
            {
                "delegate_id": "d-repeat",
                "frame_digest": "6" * 64,
                "hit": False,
                "condition": "白纸",
                "observation": "",
            },
            t_ms=6000,
        ),
        _record(
            13,
            "watch.observation",
            {
                "delegate_id": "d-repeat",
                "executor": "guard",
                "state": "armed",
                "hit": False,
                "hit_count": 1,
            },
            t_ms=6001,
        ),
        _record(
            14,
            "vision.verdict",
            {
                "delegate_id": "d-repeat",
                "frame_digest": "7" * 64,
                "hit": True,
                "condition": "白纸",
                "observation": "白纸再次出现",
            },
            t_ms=7000,
        ),
        _record(
            15,
            "watch.observation",
            {
                "delegate_id": "d-repeat",
                "executor": "guard",
                "event_id": "observation:d-repeat:15",
                "state": "hit",
                "hit": True,
                "hit_count": 2,
            },
            t_ms=7001,
        ),
        _record(
            16,
            "watch.observation",
            {
                "delegate_id": "d-repeat",
                "executor": "guard",
                "state": "cooling",
                "hit": False,
                "hit_count": 2,
            },
            t_ms=7002,
        ),
        _record(
            17,
            "playback.delivered",
            {
                "delegate_id": "d-repeat",
                "event_id": "observation:d-repeat:15",
                "transcript": "检测到白纸再次出现",
            },
            t_ms=7100,
        ),
        _record(
            18,
            "watch.handoff",
            {
                "delegate_id": "d-repeat",
                "executor": "guard",
                "hit": False,
                "outcome": "ok",
                "state": "stopped",
            },
            t_ms=8000,
        ),
        _record(
            19,
            "watch.stop",
            {
                "start_delegate_id": "d-repeat",
                "stop_delegate_id": "d-repeat-stop",
                "outcome": "ok",
                "stopped": True,
                "start_state": "stopped",
            },
            t_ms=8001,
        ),
    )


def _repeat_board_message() -> str:
    states = (
        ("armed", 0, "trusted_system"),
        ("hit", 1, "untrusted_external"),
        ("cooling", 1, "trusted_system"),
        ("waiting_reset", 1, "trusted_system"),
        ("armed", 1, "trusted_system"),
        ("hit", 2, "untrusted_external"),
        ("cooling", 2, "trusted_system"),
    )
    return json.dumps(
        {
            "type": "memory.board",
            "request_id": "repeat-evidence",
            "channels": [
                {
                    "name": "guard",
                    "summary": None,
                    "uncompressed": len(states),
                    "item_count": len(states),
                    "items": [
                        {
                            "seq": index,
                            "ts": float(index),
                            "trust": trust,
                            "priority": 90,
                            "outcome": None,
                            "refs": ["conversation:1"],
                            "content": json.dumps(
                                {"state": state, "hit_count": hit_count},
                                ensure_ascii=False,
                                separators=(",", ":"),
                            ),
                        }
                        for index, (state, hit_count, trust) in enumerate(states, 1)
                    ],
                }
            ],
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def test_repeat_evaluator_passes_one_start_two_edges_and_authoritative_stop() -> None:
    report = watch_alert_eval.evaluate_repeat_watch_alert(
        _repeat_records(),
        board_message=_repeat_board_message(),
    )

    assert report.passed
    assert {gate.name: gate.passed for gate in report.gates} == {
        name: True for name in watch_alert_eval.REPEAT_GATES
    }


async def test_production_chain_proves_two_edges_from_one_provider_start() -> None:
    records, board = await _drive_repeat_production_scenario()

    report = watch_alert_eval.evaluate_repeat_watch_alert(records, board_message=board)

    assert report.passed, (
        [(finding.code, finding.detail) for finding in report.findings],
        records,
    )
    assert report.metrics["hit_count"] == 2


@pytest.mark.parametrize(
    ("mutation", "failed_gate"),
    (
        ("remove_reset_false", "two_false_reset_observed"),
        ("reuse_hit_identity", "unique_hit_identity"),
        ("post_stop_hit", "stop_authoritative"),
        ("no_op_stop", "stop_authoritative"),
        ("missing_first_true", "first_edge_delivered"),
        ("false_between_true_and_hit_one", "first_edge_delivered"),
        ("false_between_true_and_hit_two", "second_edge_delivered"),
        ("wrong_waiting_hit_count", "two_false_reset_observed"),
        ("extra_wrong_host_counter", "two_false_reset_observed"),
        ("post_stop_non_hit_lifecycle", "stop_authoritative"),
        ("reset_lifecycle_before_false", "two_false_reset_observed"),
    ),
)
def test_repeat_evaluator_rejects_broken_two_edge_evidence(
    mutation: str,
    failed_gate: str,
) -> None:
    records = list(_repeat_records())
    if mutation == "remove_reset_false":
        records = [record for record in records if record["event_ref"] != "e012"]
    elif mutation == "missing_first_true":
        records = [record for record in records if record["event_ref"] != "e004"]
    elif mutation == "false_between_true_and_hit_one":
        records.append(
            _record(
                20,
                "vision.verdict",
                {
                    "delegate_id": "d-repeat",
                    "frame_digest": "8" * 64,
                    "hit": False,
                    "condition": "白纸",
                    "observation": "",
                },
                t_ms=2000.5,
            )
        )
    elif mutation == "false_between_true_and_hit_two":
        records.append(
            _record(
                20,
                "vision.verdict",
                {
                    "delegate_id": "d-repeat",
                    "frame_digest": "8" * 64,
                    "hit": False,
                    "condition": "白纸",
                    "observation": "",
                },
                t_ms=7000.5,
            )
        )
    elif mutation == "wrong_waiting_hit_count":
        records[10] = {
            **records[10],
            "data": {**records[10]["data"], "hit_count": 99},
        }
    elif mutation == "extra_wrong_host_counter":
        records.append(
            _record(
                20,
                "watch.observation",
                {
                    "delegate_id": "d-repeat",
                    "executor": "guard",
                    "state": "waiting_reset",
                    "hit": False,
                    "hit_count": 99,
                },
                t_ms=5500,
            )
        )
    elif mutation == "post_stop_non_hit_lifecycle":
        records.append(
            _record(
                20,
                "watch.observation",
                {
                    "delegate_id": "d-repeat",
                    "executor": "guard",
                    "state": "armed",
                    "hit": False,
                    "hit_count": 2,
                },
                t_ms=8002,
            )
        )
    elif mutation == "reuse_hit_identity":
        records[14] = {
            **records[14],
            "data": {
                **records[14]["data"],
                "event_id": "observation:d-repeat:5",
            },
        }
    elif mutation == "post_stop_hit":
        records.append(
            _record(
                20,
                "watch.observation",
                {
                    "delegate_id": "d-repeat",
                    "executor": "guard",
                    "event_id": "observation:d-repeat:19",
                    "state": "hit",
                    "hit": True,
                    "hit_count": 3,
                },
                t_ms=8002,
            )
        )
    elif mutation == "reset_lifecycle_before_false":
        records = [
            {
                **record,
                **(
                    {"t_ms": 4100.0 if record["event_ref"] == "e011" else 4200.0}
                    if record["event_ref"] in {"e011", "e013"}
                    else {}
                ),
            }
            for record in records
        ]
    else:
        records[-1] = {
            **records[-1],
            "data": {**records[-1]["data"], "stopped": False},
        }

    report = watch_alert_eval.evaluate_repeat_watch_alert(
        tuple(records),
        board_message=_repeat_board_message(),
    )

    gates = {gate.name: gate for gate in report.gates}
    assert gates[failed_gate].passed is False


def test_repeat_evaluator_rejects_a_second_start_delegate() -> None:
    records = _repeat_records() + (
        _record(
            19,
            "dispatch.ack",
            {"executor": "guard", "delegate_id": "d-second-start"},
            t_ms=100,
        ),
    )

    report = watch_alert_eval.evaluate_repeat_watch_alert(
        records,
        board_message=_repeat_board_message(),
    )

    gates = {gate.name: gate for gate in report.gates}
    assert gates["single_start_delegate"].passed is False


def test_repeat_evaluator_rejects_reused_memory_hit_identity() -> None:
    board = json.loads(_repeat_board_message())
    guard = board["channels"][0]
    hit_items = [item for item in guard["items"] if json.loads(item["content"])["state"] == "hit"]
    hit_items[1]["seq"] = hit_items[0]["seq"]

    report = watch_alert_eval.evaluate_repeat_watch_alert(
        _repeat_records(),
        board_message=json.dumps(board, ensure_ascii=False, separators=(",", ":")),
    )

    gates = {gate.name: gate for gate in report.gates}
    assert gates["unique_hit_identity"].passed is False


def test_repeat_evaluator_rejects_wrong_board_lifecycle_counter() -> None:
    board = json.loads(_repeat_board_message())
    guard = board["channels"][0]
    waiting = next(
        item for item in guard["items"] if json.loads(item["content"])["state"] == "waiting_reset"
    )
    content = json.loads(waiting["content"])
    waiting["content"] = json.dumps(
        {**content, "hit_count": 99},
        ensure_ascii=False,
        separators=(",", ":"),
    )

    report = watch_alert_eval.evaluate_repeat_watch_alert(
        _repeat_records(),
        board_message=json.dumps(board, ensure_ascii=False, separators=(",", ":")),
    )

    gates = {gate.name: gate for gate in report.gates}
    assert gates["board_lifecycle_complete"].passed is False


def test_repeat_evaluator_rejects_extra_wrong_board_lifecycle_counter() -> None:
    board = json.loads(_repeat_board_message())
    guard = board["channels"][0]
    guard["items"].insert(
        3,
        {
            "seq": 99,
            "trust": "trusted_system",
            "content": json.dumps(
                {"state": "waiting_reset", "hit_count": 99},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        },
    )

    report = watch_alert_eval.evaluate_repeat_watch_alert(
        _repeat_records(),
        board_message=json.dumps(board, ensure_ascii=False, separators=(",", ":")),
    )

    gates = {gate.name: gate for gate in report.gates}
    assert gates["board_lifecycle_complete"].passed is False


async def test_production_chain_produces_a_passing_deterministic_record_stream() -> None:
    run = await _drive_production_scenario()

    report = evaluate_watch_alert(run.records, backend="deterministic")

    assert report.passed, (
        [(finding.code, finding.detail) for finding in report.findings],
        run.records,
    )
    assert run.gateway_calls > 0
    assert run.guard_terminated_by == "handoff"
    assert run.assistant_cancellations == ("assistant-response",)
    assert run.delivery_count == 1


def test_complete_watch_alert_record_stream_passes_all_seven_gates() -> None:
    records = _complete_records()

    report = evaluate_watch_alert(records)

    assert report.scenario_id == SCENARIO_ID
    assert report.passed is True
    assert {gate.name: gate.passed for gate in report.gates} == {name: True for name in GATES}
    assert report.metrics["hit_to_speech_ms"] == 1200.0


def test_observation_hit_with_later_stopped_handoff_passes_first_edge_evaluator() -> None:
    records = tuple(
        (
            _record(
                3,
                "watch.observation",
                {
                    "delegate_id": "d-guard",
                    "executor": "guard",
                    "event_id": "observation:d-guard:11",
                    "hit": True,
                },
                t_ms=5001,
            )
            if record["kind"] == "watch.handoff"
            else record
        )
        for record in _complete_records()
    ) + (
        _record(
            10,
            "watch.handoff",
            {
                "delegate_id": "d-guard",
                "executor": "guard",
                "hit": False,
                "outcome": "ok",
                "state": "stopped",
            },
            t_ms=7000,
        ),
    )

    report = evaluate_watch_alert(records)

    assert report.passed, [(finding.code, finding.detail) for finding in report.findings]


@pytest.mark.parametrize(
    "event_id",
    (
        "garbage",
        "observation:d-other:11",
        "observation:d-guard:0",
        "observation:d-guard:-1",
        "observation:d-guard:01",
        "observation:d-guard:",
    ),
)
def test_observation_hit_requires_canonical_delegate_scoped_identity(event_id: str) -> None:
    records = tuple(
        (
            _record(
                3,
                "watch.observation",
                {
                    "delegate_id": "d-guard",
                    "executor": "guard",
                    "event_id": event_id,
                    "hit": True,
                },
                t_ms=5001,
            )
            if record["kind"] == "watch.handoff"
            else record
        )
        for record in _complete_records()
    ) + (
        _record(
            10,
            "watch.handoff",
            {
                "delegate_id": "d-guard",
                "executor": "guard",
                "hit": False,
                "outcome": "ok",
                "state": "stopped",
            },
            t_ms=7000,
        ),
    )

    report = evaluate_watch_alert(records)

    assert report.passed is False
    assert any(finding.code == "observation_identity_invalid" for finding in report.findings)


@pytest.mark.parametrize(
    ("stop_outcome", "stopped", "start_state", "expected"),
    (
        ("ok", True, "stopped", True),
        ("ok", False, "stopped", False),
        ("failed", True, "stopped", False),
        ("ok", True, "window_elapsed", False),
        ("ok", True, None, False),
    ),
)
def test_live_stop_closure_requires_effective_stop_and_stopped_start_terminal(
    stop_outcome: str,
    stopped: bool,
    start_state: str | None,
    expected: bool,
) -> None:
    assert (
        live_watch._stop_closed_monitor(  # noqa: SLF001 - pins live evidence contract
            handoff_results={
                "start-accepted": ("ok", {"state": start_state}),
                "stop-accepted": (stop_outcome, {"stopped": stopped}),
            },
            start_delegate_id="start-accepted",
            stop_delegate_id="stop-accepted",
        )
        is expected
    )


@pytest.mark.parametrize(
    ("accepted_state", "unrelated_state", "expected"),
    (
        ("window_elapsed", "stopped", False),
        ("stopped", "window_elapsed", True),
    ),
)
def test_live_stop_closure_ignores_unrelated_start_delegate(
    accepted_state: str,
    unrelated_state: str,
    expected: bool,
) -> None:
    results = {
        "start-accepted": ("ok", {"state": accepted_state}),
        "start-unrelated": ("ok", {"state": unrelated_state}),
        "stop-accepted": ("ok", {"stopped": True}),
    }

    assert (
        live_watch._stop_closed_monitor(  # noqa: SLF001 - pins live evidence contract
            handoff_results=results,
            start_delegate_id="start-accepted",
            stop_delegate_id="stop-accepted",
        )
        is expected
    )


def test_live_video_gate_requires_two_misses_before_the_hit() -> None:
    records = _complete_records()

    report = evaluate_watch_alert(records, backend="live", minimum_pre_hit_misses=2)

    gates = {gate.name: gate for gate in report.gates}
    assert gates["vision_hit_observed"].passed is False
    assert any(finding.code == "pre_hit_misses_missing" for finding in report.findings)


def test_announcement_semantics_accepts_a_grounded_condition_paraphrase() -> None:
    records = tuple(
        {
            **record,
            "data": {
                **record["data"],
                **(
                    {
                        "condition": "画面中有人",
                        "observation": "画面中有一名戴眼镜的年轻男性，正低头看向下方。",
                    }
                    if record["kind"] == "vision.verdict"
                    else {}
                ),
                **(
                    {"transcript": ("监控发现画面里有人了，是个戴眼镜的年轻男性，正低头看着下面。")}
                    if record["kind"] == "playback.delivered"
                    else {}
                ),
            },
        }
        for record in _complete_records()
    )

    report = evaluate_watch_alert(records)

    gates = {gate.name: gate for gate in report.gates}
    assert gates["announcement_semantics"].passed is True


def test_announcement_semantics_accepts_the_live_cat_sofa_paraphrase() -> None:
    records = tuple(
        {
            **record,
            "data": {
                **record["data"],
                **(
                    {
                        "condition": "猫出现在沙发上",
                        "observation": (
                            "一只虎斑猫正站在浅灰色沙发上，四爪接触沙发坐垫，身体直立面向镜头。"
                        ),
                    }
                    if record["kind"] == "vision.verdict"
                    else {}
                ),
                **(
                    {"transcript": "监控发现一只虎斑猫站在浅灰色沙发上，正对着镜头。"}
                    if record["kind"] == "playback.delivered"
                    else {}
                ),
            },
        }
        for record in _complete_records()
    )

    report = evaluate_watch_alert(records)

    gates = {gate.name: gate for gate in report.gates}
    assert gates["announcement_semantics"].passed is True


def test_announcement_semantics_requires_all_condition_anchors() -> None:
    records = tuple(
        {
            **record,
            "data": {
                **record["data"],
                **(
                    {"condition": "猫出现在沙发上", "observation": "猫仍在地板上。"}
                    if record["kind"] == "vision.verdict"
                    else {}
                ),
                **(
                    {"transcript": "监控发现一只猫仍在地板上。"}
                    if record["kind"] == "playback.delivered"
                    else {}
                ),
            },
        }
        for record in _complete_records()
    )

    report = evaluate_watch_alert(records)

    gates = {gate.name: gate for gate in report.gates}
    assert gates["announcement_semantics"].passed is False


def test_announcement_semantics_keeps_observation_fallback_for_simple_conditions() -> None:
    records = tuple(
        {
            **record,
            "data": {
                **record["data"],
                **(
                    {"condition": "宠物", "observation": "一只虎斑猫站在浅灰色沙发上。"}
                    if record["kind"] == "vision.verdict"
                    else {}
                ),
                **(
                    {"transcript": "监控发现一只虎斑猫站在浅灰色沙发上。"}
                    if record["kind"] == "playback.delivered"
                    else {}
                ),
            },
        }
        for record in _complete_records()
    )

    report = evaluate_watch_alert(records)

    gates = {gate.name: gate for gate in report.gates}
    assert gates["announcement_semantics"].passed is True


@pytest.mark.parametrize(
    "transcript",
    (
        "猫在地板上，沙发上放着靠垫。",
        "沙发上没有猫，猫还在地板上。",
    ),
)
def test_announcement_semantics_rejects_cat_and_sofa_without_the_relation(
    transcript: str,
) -> None:
    records = tuple(
        {
            **record,
            "data": {
                **record["data"],
                **(
                    {"condition": "猫出现在沙发上", "observation": "猫仍在地板上。"}
                    if record["kind"] == "vision.verdict"
                    else {}
                ),
                **({"transcript": transcript} if record["kind"] == "playback.delivered" else {}),
            },
        }
        for record in _complete_records()
    )

    report = evaluate_watch_alert(records)

    gates = {gate.name: gate for gate in report.gates}
    assert gates["announcement_semantics"].passed is False


def test_announcement_semantics_accepts_jump_to_sofa_paraphrase() -> None:
    records = tuple(
        {
            **record,
            "data": {
                **record["data"],
                **(
                    {
                        "condition": "猫出现在沙发上",
                        "observation": "一只狸花猫站在沙发坐垫上。",
                    }
                    if record["kind"] == "vision.verdict"
                    else {}
                ),
                **(
                    {"transcript": "一只狸花猫已经跳到了沙发的坐垫上。"}
                    if record["kind"] == "playback.delivered"
                    else {}
                ),
            },
        }
        for record in _complete_records()
    )

    report = evaluate_watch_alert(records)

    gates = {gate.name: gate for gate in report.gates}
    assert gates["announcement_semantics"].passed is True


@pytest.mark.parametrize(
    "transcript",
    (
        "猫不站在沙发上。",
        "猫没站在沙发上。",
        "猫不是站在沙发上。",
        "猫没跳到沙发上。",
        "猫站在沙发旁边。",
    ),
)
def test_announcement_semantics_rejects_negated_or_wrong_cat_sofa_relation(
    transcript: str,
) -> None:
    records = tuple(
        {
            **record,
            "data": {
                **record["data"],
                **(
                    {"condition": "猫出现在沙发上", "observation": "猫仍在地板上。"}
                    if record["kind"] == "vision.verdict"
                    else {}
                ),
                **({"transcript": transcript} if record["kind"] == "playback.delivered" else {}),
            },
        }
        for record in _complete_records()
    )

    report = evaluate_watch_alert(records)

    gates = {gate.name: gate for gate in report.gates}
    assert gates["announcement_semantics"].passed is False


@pytest.mark.parametrize("transcript", ("猫已经在沙发上了。", "监控发现猫在沙发上。"))
def test_announcement_semantics_accepts_plain_cat_on_sofa_relation(transcript: str) -> None:
    records = tuple(
        {
            **record,
            "data": {
                **record["data"],
                **(
                    {"condition": "猫出现在沙发上", "observation": "猫站在沙发坐垫上。"}
                    if record["kind"] == "vision.verdict"
                    else {}
                ),
                **({"transcript": transcript} if record["kind"] == "playback.delivered" else {}),
            },
        }
        for record in _complete_records()
    )

    report = evaluate_watch_alert(records)

    gates = {gate.name: gate for gate in report.gates}
    assert gates["announcement_semantics"].passed is True


@pytest.mark.parametrize(
    "transcript",
    (
        "一只狸花猫已经跳到了沙发坐垫上。",
        "沙发上出现了一只猫。",
        "沙发上发现一只猫。",
        "猫不仅在沙发上。",
    ),
)
def test_announcement_semantics_accepts_common_cat_sofa_relation_forms(
    transcript: str,
) -> None:
    records = tuple(
        {
            **record,
            "data": {
                **record["data"],
                **(
                    {"condition": "猫出现在沙发上", "observation": "猫站在沙发坐垫上。"}
                    if record["kind"] == "vision.verdict"
                    else {}
                ),
                **({"transcript": transcript} if record["kind"] == "playback.delivered" else {}),
            },
        }
        for record in _complete_records()
    )

    report = evaluate_watch_alert(records)

    gates = {gate.name: gate for gate in report.gates}
    assert gates["announcement_semantics"].passed is True


def test_announcement_semantics_rejects_cat_above_the_sofa() -> None:
    records = tuple(
        {
            **record,
            "data": {
                **record["data"],
                **(
                    {"condition": "猫出现在沙发上", "observation": "猫仍在地板上。"}
                    if record["kind"] == "vision.verdict"
                    else {}
                ),
                **(
                    {"transcript": "猫在沙发上方。"}
                    if record["kind"] == "playback.delivered"
                    else {}
                ),
            },
        }
        for record in _complete_records()
    )

    report = evaluate_watch_alert(records)

    gates = {gate.name: gate for gate in report.gates}
    assert gates["announcement_semantics"].passed is False


def test_announcement_semantics_rejects_an_unrelated_object() -> None:
    records = tuple(
        {
            **record,
            "data": {
                **record["data"],
                **(
                    {"transcript": "监控发现了其他物品"}
                    if record["kind"] == "playback.delivered"
                    else {}
                ),
            },
        }
        for record in _complete_records()
    )

    report = evaluate_watch_alert(records)

    gates = {gate.name: gate for gate in report.gates}
    assert gates["announcement_semantics"].passed is False


def test_watch_alert_requires_one_correlated_delegate_trajectory() -> None:
    records = tuple(
        {
            **record,
            "data": {
                **record["data"],
                **(
                    {"delegate_id": "d-other"}
                    if record["kind"] in {"dispatch.ack", "dispatch.spoken"}
                    else {}
                ),
            },
        }
        for record in _complete_records()
    )

    report = evaluate_watch_alert(records)

    assert report.passed is False
    assert any(finding.code == "vision_hit_missing" for finding in report.findings)


def test_watch_alert_requires_spoken_ack_for_the_hit_delegate_not_a_decoy() -> None:
    records = tuple(
        record for record in _complete_records() if record["kind"] != "dispatch.spoken"
    ) + (
        _record(
            10,
            "dispatch.ack",
            {"executor": "guard", "delegate_id": "d-decoy"},
            t_ms=100,
        ),
        _record(
            11,
            "dispatch.spoken",
            {"delegate_id": "d-decoy", "transcript": "另一个任务已经开始"},
            t_ms=200,
        ),
    )

    report = evaluate_watch_alert(records)

    gates = {gate.name: gate for gate in report.gates}
    assert gates["dispatch_acknowledged"].passed is False
    assert any(finding.code == "dispatch_speech_missing" for finding in report.findings)


@pytest.mark.parametrize(
    ("status_data", "status_t_ms"),
    (
        ({"executor": "watch", "sync_result": True, "state": "running"}, 5100.0),
        ({"executor": "guard", "sync_result": True, "state": "running"}, 7000.0),
    ),
)
def test_watch_alert_requires_same_executor_status_before_the_hit(
    status_data: dict[str, object],
    status_t_ms: float,
) -> None:
    records = tuple(
        {
            **record,
            **({"t_ms": status_t_ms} if record["kind"] == "status.sync" else {}),
            "data": status_data if record["kind"] == "status.sync" else record["data"],
        }
        for record in _complete_records()
    )

    report = evaluate_watch_alert(records)

    assert report.passed is False
    assert any(finding.code == "running_status_missing" for finding in report.findings)


def test_announcement_semantics_rejects_a_negated_condition() -> None:
    records = tuple(
        {
            **record,
            "data": {
                **record["data"],
                **(
                    {"transcript": "监控确认画面里没有出现水杯"}
                    if record["kind"] == "playback.delivered"
                    else {}
                ),
            },
        }
        for record in _complete_records()
    )

    report = evaluate_watch_alert(records)

    gates = {gate.name: gate for gate in report.gates}
    assert gates["announcement_semantics"].passed is False


def test_announcement_semantics_rejects_suffix_negation() -> None:
    records = tuple(
        {
            **record,
            "data": {
                **record["data"],
                **(
                    {"transcript": "水杯并未出现"} if record["kind"] == "playback.delivered" else {}
                ),
            },
        }
        for record in _complete_records()
    )

    report = evaluate_watch_alert(records)

    gates = {gate.name: gate for gate in report.gates}
    assert gates["announcement_semantics"].passed is False


def test_live_backend_marks_policy_only_gates_not_applicable() -> None:
    records = tuple(record for record in _complete_records() if record["kind"] != "preemption")

    report = evaluate_watch_alert(records, backend="live")

    statuses = {gate.name: gate.status for gate in report.gates}
    assert report.backend == "live"
    assert report.passed is True
    assert statuses["assistant_preemption_policy"] == "not_applicable"
    assert statuses["user_speech_protected"] == "not_applicable"
    assert evaluate_watch_alert(records, backend="deterministic").passed is False


def test_live_backend_still_requires_same_turn_status() -> None:
    records = tuple(record for record in _complete_records() if record["kind"] != "status.sync")

    report = evaluate_watch_alert(records, backend="live")

    statuses = {gate.name: gate.status for gate in report.gates}
    assert report.passed is False
    assert statuses["status_same_turn"] == "failed"


def test_live_backend_requires_a_spoken_dispatch_acknowledgement() -> None:
    records = tuple(record for record in _complete_records() if record["kind"] != "dispatch.spoken")

    report = evaluate_watch_alert(records, backend="live")

    gates = {gate.name: gate for gate in report.gates}
    assert report.passed is False
    assert gates["dispatch_acknowledged"].passed is False
    assert any(finding.code == "dispatch_speech_missing" for finding in report.findings)


def test_synthetic_handoff_without_vision_digest_fails_real_hit_gate() -> None:
    records = (
        _record(1, "dispatch.ack", {"executor": "guard", "delegate_id": "d-guard"}, t_ms=0),
        _record(
            2,
            "watch.handoff",
            {"delegate_id": "d-guard", "executor": "guard", "hit": True, "outcome": "ok"},
            t_ms=1,
        ),
    )

    report = evaluate_watch_alert(records)

    gates = {gate.name: gate for gate in report.gates}
    assert gates["vision_hit_observed"].passed is False
    assert any(finding.code == "vision_hit_missing" for finding in report.findings)


def test_guard_hit_during_user_speech_can_never_pass_preemption_gate() -> None:
    records = (
        _record(
            1,
            "preemption",
            {"executor": "guard", "hit": True, "assistant_cancelled": True, "user_speaking": True},
            t_ms=0,
        ),
    )

    report = evaluate_watch_alert(records)

    gates = {gate.name: gate for gate in report.gates}
    assert gates["user_speech_protected"].passed is False
    assert any(finding.code == "user_speech_preempted" for finding in report.findings)


@pytest.mark.parametrize(
    "argv",
    (
        ("--interval-s", "1", "--artifacts", "out"),
        ("--duration-s", "29", "--artifacts", "out"),
    ),
)
def test_live_cli_rejects_out_of_range_windows(argv: tuple[str, ...]) -> None:
    with pytest.raises(SystemExit) as failure:
        live_watch.parse_args(argv)

    assert failure.value.code == 2


def test_live_cli_accepts_an_absolute_video_file(tmp_path: Path) -> None:
    video = tmp_path / "cat-sofa.mp4"
    video.write_bytes(b"video")

    args = live_watch.parse_args(
        (
            "--mode",
            "guard",
            "--video-file",
            str(video),
            "--artifacts",
            str(tmp_path / "artifacts"),
        )
    )

    assert args.video_file == video


def test_live_cli_accepts_explicit_first_hit_evidence_target(tmp_path: Path) -> None:
    video = tmp_path / "cat-sofa.mp4"
    video.write_bytes(b"video")

    first_hit = live_watch.parse_args(
        (
            "--mode",
            "guard",
            "--video-file",
            str(video),
            "--evidence-target",
            "first-hit",
            "--artifacts",
            str(tmp_path / "first-hit"),
        )
    )
    repeat = live_watch.parse_args(("--artifacts", str(tmp_path / "repeat")))

    assert first_hit.evidence_target == "first-hit"
    assert repeat.evidence_target == "repeat"


def test_live_cli_rejects_watch_with_a_video_file(tmp_path: Path) -> None:
    video = tmp_path / "cat-sofa.mp4"
    video.write_bytes(b"video")

    with pytest.raises(SystemExit) as failure:
        live_watch.parse_args(
            (
                "--mode",
                "watch",
                "--video-file",
                str(video),
                "--artifacts",
                str(tmp_path / "artifacts"),
            )
        )

    assert failure.value.code == 2


def test_live_cli_rejects_an_invalid_video_file(tmp_path: Path) -> None:
    for video in (Path("cat-sofa.mp4"), tmp_path / "missing.mp4", tmp_path):
        with pytest.raises(SystemExit) as failure:
            live_watch.parse_args(
                ("--video-file", str(video), "--artifacts", str(tmp_path / "artifacts"))
            )

        assert failure.value.code == 2


@pytest.mark.parametrize("transcript", ("检测到水杯", "检测到其他物品"))
def test_live_renderer_records_post_hit_delivery_before_semantic_evaluation(
    transcript: str,
) -> None:
    recorder = live_watch.Recorder()
    renderer = live_watch.Renderer(recorder)
    renderer.delegate_id = "d-guard"
    renderer.observation = "桌面上出现一个白色水杯"
    renderer.expect_hit_delivery(
        is_correlated=lambda response_id: response_id == "response-hit",
    )

    renderer.on_delivery(
        PlaybackCompletion(
            session_epoch=1,
            response_id="response-hit",
            utterance_id="utterance-hit",
            generation_epoch=1,
            text=transcript,
            disposition="spoken",
            started=True,
        )
    )

    assert [record["kind"] for record in recorder.records] == ["playback.delivered"]
    assert recorder.records[0]["data"] == {
        "delegate_id": "d-guard",
        "transcript": transcript,
    }


def test_live_renderer_ignores_uncorrelated_status_speech_after_a_hit() -> None:
    recorder = live_watch.Recorder()
    renderer = live_watch.Renderer(recorder)
    renderer.delegate_id = "d-guard"
    renderer.observation = "桌面上出现一个白色水杯"
    renderer.expect_hit_delivery(
        is_correlated=lambda response_id: response_id == "response-hit",
    )

    renderer.on_delivery(
        PlaybackCompletion(
            session_epoch=1,
            response_id="response-status",
            utterance_id="utterance-status",
            generation_epoch=1,
            text="监控水杯仍在运行",
            disposition="spoken",
            started=True,
        )
    )

    assert recorder.records == []


def test_live_renderer_snapshots_hit_event_ids_before_delivery_cleanup() -> None:
    recorder = live_watch.Recorder()
    renderer = live_watch.Renderer(recorder)
    renderer.delegate_id = "d-guard"
    renderer.observation = "画面中出现眼镜"

    class _Session:
        current_generation = SimpleNamespace(
            response_id="response-hit",
            utterance_id="utterance-hit",
            generation_epoch=1,
        )

        def __init__(self) -> None:
            self.events = ("observation:d-guard:11",)

        def response_event_ids(self, _response_id: str) -> tuple[str, ...]:
            return self.events

    session = _Session()

    class _Service:
        def __init__(self) -> None:
            self.session = session

        def playback_done(
            self,
            utterance_id: str,
            generation_epoch: int,
            _played_ms: int,
        ) -> bool:
            session.events = ()
            renderer.on_delivery(
                PlaybackCompletion(
                    session_epoch=1,
                    response_id="response-hit",
                    utterance_id=utterance_id,
                    generation_epoch=generation_epoch,
                    text="监控发现有人戴着眼镜",
                    disposition="spoken",
                    started=True,
                )
            )
            return True

    renderer.service = _Service()
    renderer.expect_hit_delivery(
        is_correlated=lambda response_id: (
            "observation:d-guard:11" in renderer.response_event_ids.get(response_id, ())
        ),
    )

    renderer.on_terminal("utterance-hit", 1)

    assert [record["kind"] for record in recorder.records] == ["playback.delivered"]
    assert recorder.records[0]["data"]["event_id"] == "observation:d-guard:11"


def test_live_renderer_records_only_the_correlated_spoken_dispatch_acknowledgement() -> None:
    recorder = live_watch.Recorder()
    renderer = live_watch.Renderer(recorder)
    renderer.expect_dispatch_acknowledgement()
    renderer.bind_dispatch_delegate("d-guard", "response-ack")

    renderer.on_delivery(
        PlaybackCompletion(
            session_epoch=1,
            response_id="response-other",
            utterance_id="utterance-other",
            generation_epoch=1,
            text="不相关的回答",
            disposition="spoken",
            started=True,
        )
    )
    renderer.on_delivery(
        PlaybackCompletion(
            session_epoch=1,
            response_id="response-ack",
            utterance_id="utterance-ack",
            generation_epoch=2,
            text="已经开始监控水杯",
            disposition="spoken",
            started=True,
        )
    )

    assert [record["kind"] for record in recorder.records] == ["dispatch.spoken"]
    assert renderer.acknowledged.is_set()


def test_live_renderer_binds_spoken_origin_after_dispatch_acceptance() -> None:
    recorder = live_watch.Recorder()
    renderer = live_watch.Renderer(recorder)
    renderer.expect_dispatch_acknowledgement()

    renderer.on_delivery(
        PlaybackCompletion(
            session_epoch=1,
            response_id="response-origin",
            utterance_id="utterance-origin",
            generation_epoch=1,
            text="好的，我开始帮你留意。",
            disposition="spoken",
            started=True,
        )
    )

    assert recorder.records == []
    assert not renderer.acknowledged.is_set()

    renderer.bind_dispatch_delegate("d-guard", "response-origin")

    assert [record["kind"] for record in recorder.records] == ["dispatch.spoken"]
    assert recorder.records[0]["data"]["delegate_id"] == "d-guard"
    assert renderer.acknowledged.is_set()


def test_live_renderer_accepts_spoken_origin_after_dispatch_is_bound() -> None:
    recorder = live_watch.Recorder()
    renderer = live_watch.Renderer(recorder)
    renderer.expect_dispatch_acknowledgement()
    renderer.bind_dispatch_delegate("d-guard", "response-origin")

    renderer.on_delivery(
        PlaybackCompletion(
            session_epoch=1,
            response_id="response-origin",
            utterance_id="utterance-origin",
            generation_epoch=1,
            text="没问题，已经开始监控。",
            disposition="spoken",
            started=True,
        )
    )

    assert [record["kind"] for record in recorder.records] == ["dispatch.spoken"]
    assert recorder.records[0]["data"]["delegate_id"] == "d-guard"
    assert renderer.acknowledged.is_set()


def test_live_renderer_rejects_an_unrelated_spoken_response_after_dispatch() -> None:
    recorder = live_watch.Recorder()
    renderer = live_watch.Renderer(recorder)
    renderer.expect_dispatch_acknowledgement()
    renderer.bind_dispatch_delegate("d-guard", "response-origin")

    renderer.on_delivery(
        PlaybackCompletion(
            session_epoch=1,
            response_id="response-weather",
            utterance_id="utterance-weather",
            generation_epoch=1,
            text="今天上海天气晴朗。",
            disposition="spoken",
            started=True,
        )
    )

    assert recorder.records == []
    assert not renderer.acknowledged.is_set()


def test_live_renderer_alert_records_identity_and_clears_accumulated_playback() -> None:
    recorder = live_watch.Recorder()
    renderer = live_watch.Renderer(recorder)

    class _Service:
        def __init__(self) -> None:
            self.started: list[tuple[str, int]] = []
            self.cleared: list[tuple[str, int, int]] = []

        def playback_started(self, utterance_id: str, generation_epoch: int) -> None:
            self.started.append((utterance_id, generation_epoch))

        def playback_cleared(
            self,
            utterance_id: str,
            generation_epoch: int,
            played_ms: int,
        ) -> None:
            self.cleared.append((utterance_id, generation_epoch, played_ms))

    service = _Service()
    renderer.service = service
    renderer.on_frame(PlaybackFrame("old", 3, 0, b"\x00" * 96))

    renderer.on_alert("old", 3)

    assert service.started == [("old", 3)]
    assert service.cleared == [("old", 3, 2)]
    assert [record["kind"] for record in recorder.records] == ["renderer.alert"]
    assert recorder.records[0]["data"] == {"generation_qualified": True}


def test_live_renderer_tone_alert_does_not_invent_a_playback_clear() -> None:
    recorder = live_watch.Recorder()
    renderer = live_watch.Renderer(recorder)

    class _Service:
        def __init__(self) -> None:
            self.cleared: list[tuple[str, int, int]] = []

        def playback_cleared(
            self,
            utterance_id: str,
            generation_epoch: int,
            played_ms: int,
        ) -> None:
            self.cleared.append((utterance_id, generation_epoch, played_ms))

    service = _Service()
    renderer.service = service

    renderer.on_alert(None, None)

    assert service.cleared == []
    assert [record["kind"] for record in recorder.records] == ["renderer.alert"]
    assert recorder.records[0]["data"] == {"generation_qualified": False}


async def test_live_runner_selects_camera_and_wires_alert_before_external_startup(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class _Settings:
        def require_qwen_realtime(self) -> tuple[str, str, str, str]:
            return ("provider", "model", "url", "realtime-key")

        def require_api_key(self) -> str:
            return "api-key"

        def require_tavily_api_key(self) -> str:
            return "tavily-key"

    class _StopBeforeStartup(Exception):
        pass

    video = tmp_path / "cat-sofa.mp4"
    video.write_bytes(b"video")
    expected_cameras = [("local", None), ("file", video)]

    def build(_settings: object, **kwargs: object) -> None:
        assert (kwargs["camera_source"], kwargs["camera_file"]) == expected_cameras.pop(0)
        on_audio_alert = kwargs["on_audio_alert"]
        assert callable(on_audio_alert)
        on_audio_alert("old", 3)
        raise _StopBeforeStartup

    monkeypatch.setattr(live_watch, "_settings", lambda: _Settings())
    monkeypatch.setattr(live_watch, "build_qwen_realtime_assembly", build)
    recorder = live_watch.Recorder()

    for video_file in (None, video):
        with pytest.raises(_StopBeforeStartup):
            await live_watch._run(
                SimpleNamespace(camera_index=0, mode="guard", video_file=video_file),
                recorder,
            )

    assert expected_cameras == []
    assert [record["kind"] for record in recorder.records] == [
        "renderer.alert",
        "renderer.alert",
    ]
    assert all(record["data"] == {"generation_qualified": True} for record in recorder.records)


async def test_live_recording_gateway_waits_for_running_status_before_vlm() -> None:
    order: list[str] = []

    class _Inner:
        def __init__(self) -> None:
            self.called = asyncio.Event()

        async def complete(self, **_kwargs: object) -> GatewayCompletion:
            order.append("complete")
            self.called.set()
            return GatewayCompletion('{"hit":true,"observation":"画面中有人"}')

    async def restart_video() -> None:
        order.append("restart")

    inner = _Inner()
    release = asyncio.Event()
    frames = SimpleNamespace(last_digest="a" * 64)
    gateway = live_watch.RecordingGateway(
        inner,
        frames,
        live_watch.Recorder(),
        lambda: "d-guard",
        "画面中有人",
        release=release,
        prepare_after_release=restart_video,
    )

    task = asyncio.create_task(
        gateway.complete(
            model="watch-vl",
            system="classify",
            prompt="监控条件：画面中有人",
            json_schema={"type": "object"},
            images=(),
        )
    )
    await asyncio.sleep(0)
    assert inner.called.is_set() is False

    release.set()
    await task

    assert inner.called.is_set()
    assert order == ["restart", "complete"]


@pytest.mark.parametrize(
    "payload",
    (
        '{"hit":true,"observation":"眼镜","extra":"field"}',
        '{"hit":true,"observation":""}',
        '{"hit":true,"observation":"眼镜\\u0000"}',
        '{"hit":true,"observation":"' + "眼" * 401 + '"}',
    ),
)
async def test_live_recording_gateway_rejects_every_production_invalid_verdict(
    payload: str,
) -> None:
    class _Inner:
        async def complete(self, **_kwargs: object) -> GatewayCompletion:
            return GatewayCompletion(payload)

    recorder = live_watch.Recorder()
    gateway = live_watch.RecordingGateway(
        _Inner(),
        SimpleNamespace(last_digest="a" * 64),
        recorder,
        lambda: "d-guard",
        "出现眼镜",
    )

    await gateway.complete(
        model="watch-vl",
        system="classify",
        prompt="监控条件：出现眼镜",
        json_schema={"type": "object"},
        images=(),
    )

    assert recorder.records == []


async def test_live_runner_streams_synthetic_audio_at_realtime_pcm_rate() -> None:
    class _Service:
        def __init__(self) -> None:
            self.chunks: list[bytes] = []

        async def send_audio(self, pcm: bytes) -> None:
            self.chunks.append(pcm)

    service = _Service()
    sleeps: list[float] = []

    async def sleep(delay: float) -> None:
        sleeps.append(delay)

    await live_watch._stream_synthetic_audio(
        service,
        b"\x01\x02" * 2_000,
        sleep=sleep,
    )

    assert tuple(map(len, service.chunks)) == (3_200, 800, *(3_200 for _ in range(10)))
    assert sum(sleeps) == pytest.approx(1.125)
    assert all(chunk == b"\x00" * 3_200 for chunk in service.chunks[-10:])


async def test_live_runner_waits_for_a_new_acceptance_with_the_expected_op() -> None:
    existing = SimpleNamespace(
        session_epoch=1,
        call_id="old",
        provider_response_id="response-old",
        acceptance=SimpleNamespace(
            accepted=True,
            delegate_id="d-old",
            executor="guard",
            sync_result=False,
            op="start",
        ),
    )
    wrong_op = SimpleNamespace(
        session_epoch=1,
        call_id="stop",
        provider_response_id="response-stop",
        acceptance=SimpleNamespace(
            accepted=True,
            delegate_id="d-stop",
            executor="guard",
            sync_result=False,
            op="stop",
        ),
    )
    expected_acceptance = SimpleNamespace(
        accepted=True,
        delegate_id="d-start",
        executor="guard",
        sync_result=False,
        op="start",
    )
    expected = SimpleNamespace(
        session_epoch=1,
        call_id="start",
        provider_response_id="response-start",
        acceptance=expected_acceptance,
    )
    service = SimpleNamespace(
        tool_call_acceptances=lambda: (existing, wrong_op, expected),
        stopped=False,
    )
    acceptance = await live_watch._wait_for_tool_acceptance(
        service,
        existing=frozenset({(1, "old")}),
        executor="guard",
        op="start",
    )

    assert acceptance is expected


@pytest.mark.parametrize(("evidence_target", "required_hits"), (("first-hit", 1), ("repeat", 2)))
async def test_live_evidence_target_waits_for_the_declared_number_of_delivered_hits(
    evidence_target: str,
    required_hits: int,
) -> None:
    renderer = SimpleNamespace(delivered_event_ids=set())
    event_ids: list[str] = []
    waiting = asyncio.create_task(
        live_watch._wait_for_evidence_target(
            renderer,
            event_ids,
            evidence_target=evidence_target,
            timeout=1.0,
        )
    )

    for index in range(required_hits):
        event_id = f"observation:d-guard:{index + 1}"
        event_ids.append(event_id)
        renderer.delivered_event_ids.add(event_id)
        await asyncio.sleep(0.06)
        if index + 1 < required_hits:
            assert waiting.done() is False

    await waiting


async def test_live_runner_matches_completed_sync_status_after_delegate_reclamation() -> None:
    expected_acceptance = SimpleNamespace(
        accepted=True,
        delegate_id="d-status",
        executor="guard",
        sync_result=True,
        op="status",
    )
    service = SimpleNamespace(
        tool_call_acceptances=lambda: (
            SimpleNamespace(
                session_epoch=1,
                call_id="status",
                provider_response_id="response-status",
                acceptance=expected_acceptance,
            ),
        ),
        stopped=False,
    )
    acceptance = await live_watch._wait_for_tool_acceptance(
        service,
        existing=frozenset(),
        executor="guard",
        op="status",
        timeout=0.01,
    )

    assert acceptance.provider_response_id == "response-status"
    assert acceptance.acceptance is expected_acceptance


async def test_live_runner_matches_completed_start_after_delegate_reclamation() -> None:
    expected_acceptance = SimpleNamespace(
        accepted=True,
        delegate_id="d-start",
        executor="guard",
        sync_result=False,
        op="start",
    )
    service = SimpleNamespace(
        tool_call_acceptances=lambda: (
            SimpleNamespace(
                session_epoch=1,
                call_id="start",
                provider_response_id="response-start",
                acceptance=expected_acceptance,
            ),
        ),
        stopped=False,
    )
    acceptance = await live_watch._wait_for_tool_acceptance(
        service,
        existing=frozenset(),
        executor="guard",
        op="start",
        timeout=0.01,
    )

    assert acceptance.provider_response_id == "response-start"
    assert acceptance.acceptance is expected_acceptance


async def test_live_runner_waits_for_the_first_camera_frame() -> None:
    frame = object()

    class _Source:
        def __init__(self) -> None:
            self.calls = 0

        async def snapshot(self) -> object | None:
            self.calls += 1
            return frame if self.calls == 3 else None

    sleeps: list[float] = []

    async def sleep(delay: float) -> None:
        sleeps.append(delay)

    source = _Source()

    captured = await live_watch._wait_for_camera_frame(source, timeout=1.0, sleep=sleep)

    assert captured is frame
    assert source.calls == 3
    assert sleeps == [0.05, 0.05]


def test_live_runner_limits_provider_tools_without_narrowing_host_bindings() -> None:
    tools = compile_tool_schema((WATCH_MANIFEST, GUARD_MANIFEST))

    provider_tools = live_watch._scenario_provider_tools(tools, "guard")

    names = {
        schema["function"]["name"]
        for schema in provider_tools.schemas
        if isinstance(schema.get("function"), dict)
    }
    assert names == {"guard__start", "guard__stop", "guard__status"}
    for schema in provider_tools.schemas:
        parameters = schema["function"]["parameters"]
        assert "origin_ref" not in parameters["properties"]
        assert "origin_ref" not in parameters.get("required", ())
    assert provider_tools.bindings is tools.bindings


def test_live_runner_uses_only_public_observation_surface() -> None:
    source = inspect.getsource(live_watch)

    assert not any(fragment in source for fragment in ("service._", "adapter._"))
    assert "provider_tool_view=" in source
    assert "configure_observation_ports(" in source


def test_live_recorder_allowlists_bounds_and_redacts_text() -> None:
    configured_token = "".join(("s", "k-configured-secret"))
    visible_token = "".join(("s", "k-camera-visible-secret"))
    recorder = live_watch.Recorder(sensitive_values=(configured_token,))

    recorder.add(
        "vision.verdict",
        {
            "delegate_id": "d-guard",
            "frame_digest": "a" * 64,
            "hit": True,
            "condition": "出现眼镜",
            "observation": f"{configured_token} {visible_token} " + "画" * 800,
            "unexpected": "must-not-persist",
        },
    )

    data = recorder.records[0]["data"]
    assert "unexpected" not in data
    assert configured_token not in data["observation"]
    assert visible_token not in data["observation"]
    assert len(data["observation"]) <= live_watch.MAX_ARTIFACT_TEXT


def test_live_artifact_persists_repeat_lifecycle_report(tmp_path: Path) -> None:
    recorder = live_watch.Recorder()
    recorder.records.extend(_repeat_records())
    recorder.board_message = _repeat_board_message()

    live_watch._write(tmp_path, recorder, "pass", None)

    persisted = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert persisted["repeat_report"]["metrics"]["hit_count"] == 2
    assert all(gate["passed"] for gate in persisted["repeat_report"]["gates"])
    evidence_text = json.dumps(persisted["board_evidence"], ensure_ascii=False)
    evidence_contents = [
        json.loads(item["content"]) for item in persisted["board_evidence"]["channels"][0]["items"]
    ]
    assert all("state" in content and "hit_count" in content for content in evidence_contents)
    assert not any(field in evidence_text for field in ("condition", "observation", "media_ref"))
    replayed = watch_alert_eval.evaluate_repeat_watch_alert(
        tuple(
            json.loads(line)
            for line in (tmp_path / "records.jsonl").read_text(encoding="utf-8").splitlines()
        ),
        board_message=json.dumps(
            persisted["board_evidence"],
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        backend="live",
    )
    assert json.loads(json.dumps(asdict(replayed))) == persisted["repeat_report"]


def test_live_first_hit_artifact_passes_without_claiming_repeat_evidence(tmp_path: Path) -> None:
    recorder = live_watch.Recorder()
    recorder.records.extend(_complete_records())

    passed = live_watch._write(
        tmp_path,
        recorder,
        "pass",
        None,
        evidence_target="first-hit",
    )

    persisted = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert passed is True
    assert persisted["evidence_target"] == "first-hit"
    assert not any(gate["passed"] is False for gate in persisted["report"]["gates"])
    assert any(not gate["passed"] for gate in persisted["repeat_report"]["gates"])


@pytest.mark.parametrize(
    ("outcome", "expected"),
    ((True, live_watch.EXIT_PASS), (False, live_watch.EXIT_FAIL)),
)
async def test_live_main_maps_product_result_to_exit_code(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    outcome: bool,
    expected: int,
) -> None:
    async def run(_args: object, _recorder: object) -> bool:
        return outcome

    monkeypatch.setattr(live_watch, "_run", run)

    exit_code = await live_watch._main(SimpleNamespace(artifacts=tmp_path))

    report = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert exit_code == expected
    assert report["classification"] == ("pass" if outcome else "fail")
    assert report["report"]["backend"] == "live"


async def test_live_main_redacts_unexpected_failure_detail(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fail(_args: object, _recorder: object) -> bool:
        raise RuntimeError("credential=do-not-write")

    monkeypatch.setattr(live_watch, "_run", fail)

    exit_code = await live_watch._main(SimpleNamespace(artifacts=tmp_path))

    report_text = (tmp_path / "report.json").read_text(encoding="utf-8")
    report = json.loads(report_text)
    assert exit_code == live_watch.EXIT_HARNESS_INVALID
    assert report["reason"] == "RuntimeError"
    assert "do-not-write" not in report_text


async def test_live_main_persists_provider_cancellation_as_invalid_harness(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def cancelled(_args: object, _recorder: object) -> bool:
        raise asyncio.CancelledError

    monkeypatch.setattr(live_watch, "_run", cancelled)

    exit_code = await live_watch._main(SimpleNamespace(artifacts=tmp_path))

    report = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert exit_code == live_watch.EXIT_HARNESS_INVALID
    assert report["classification"] == "harness_invalid"
    assert report["reason"] == "CancelledError"
