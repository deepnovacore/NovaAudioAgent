from __future__ import annotations

import asyncio
import base64
import json
from collections import deque

import pytest

from scripts.realtime_probe.models import HostState, ScenarioStep
from scripts.realtime_probe.provider import ProviderError
from scripts.realtime_probe.qwen import QwenProtocol, QwenRealtimeProvider
from scripts.realtime_probe.runner import RealtimeProbeSession


class FakeSocket:
    def __init__(self, incoming: list[dict[str, object]] | None = None) -> None:
        self.incoming = deque(json.dumps(event) for event in (incoming or []))
        self.sent: list[dict[str, object]] = []
        self.closed = False

    async def send(self, payload: str) -> None:
        self.sent.append(json.loads(payload))

    async def recv(self) -> str:
        if not self.incoming:
            raise AssertionError("test socket has no queued provider event")
        return self.incoming.popleft()

    async def close(self) -> None:
        self.closed = True


class FakeProvider:
    def __init__(self) -> None:
        self.sent: list[dict[str, object]] = []
        self.incoming: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        self.connected = False
        self.closed = False

    async def connect(self) -> dict[str, object]:
        self.connected = True
        return {"type": "session.created", "session": {"id": "session-test"}}

    async def send(self, event: dict[str, object]) -> None:
        self.sent.append(event)
        event_type = event["type"]
        if event_type == "session.update":
            await self.incoming.put({"type": "session.updated", "session": {"id": "session-test"}})
        elif event_type == "conversation.item.create":
            item = event["item"]
            assert isinstance(item, dict)
            await self.incoming.put({"type": "rate_limits.updated"})
            await self.incoming.put({"type": "conversation.item.created", "item": item})
        elif event_type == "response.create":
            await self.incoming.put(
                {
                    "type": "response.audio.delta",
                    "response_id": "response-progress",
                    "delta": "AA==",
                }
            )
            await self.incoming.put(
                {
                    "type": "response.audio_transcript.done",
                    "response_id": "response-progress",
                    "transcript": "Codex 刚完成了页面骨架。",
                }
            )
            await self.incoming.put(
                {
                    "type": "response.done",
                    "response": {"id": "response-progress", "status": "completed"},
                }
            )

    async def receive(self) -> dict[str, object]:
        return await self.incoming.get()

    async def close(self) -> None:
        self.closed = True


def test_qwen_protocol_uses_only_documented_response_fields() -> None:
    progress = QwenProtocol.progress_item(
        item_id="item-progress-1",
        run_id="run-1",
        delegate_id="delegate-1",
        progress_id="progress-1",
        nonce="nonce-1",
        fact="Codex 后台已完成页面骨架。",
    )
    response = QwenProtocol.response_create()

    assert progress["role"] == "user"
    assert progress["content"][0]["type"] == "input_text"
    assert "<nova_progress_event>" in progress["content"][0]["text"]
    assert response == {"type": "response.create", "response": {"modalities": ["audio", "text"]}}
    assert "instructions" not in response["response"]


@pytest.mark.asyncio
async def test_qwen_provider_connects_with_key_but_never_reports_it() -> None:
    key = "secret-dashscope-key"
    calls: list[tuple[str, dict[str, object]]] = []

    async def failing_factory(url: str, **kwargs: object) -> FakeSocket:
        calls.append((url, kwargs))
        raise RuntimeError(f"authorization failed for {key}")

    provider = QwenRealtimeProvider(api_key=key, websocket_factory=failing_factory)

    with pytest.raises(ProviderError) as raised:
        await provider.connect()

    assert calls[0][1]["additional_headers"] == {"Authorization": f"Bearer {key}"}
    assert key not in str(raised.value)
    assert raised.value.reason_code == "qwen_connection_failed"


@pytest.mark.asyncio
async def test_qwen_provider_encodes_and_decodes_wire_events() -> None:
    socket = FakeSocket([{"type": "session.created", "session": {"id": "session-1"}}])

    async def factory(url: str, **kwargs: object) -> FakeSocket:
        return socket

    provider = QwenRealtimeProvider(api_key="secret", websocket_factory=factory)

    created = await provider.connect()
    await provider.send({"type": "response.cancel"})
    await provider.close()

    assert created["session"]["id"] == "session-1"
    assert socket.sent[0]["type"] == "response.cancel"
    assert socket.sent[0]["event_id"].startswith("event_")
    assert socket.closed is True


@pytest.mark.asyncio
async def test_qwen_provider_exposes_only_sanitized_provider_error_code() -> None:
    socket = FakeSocket(
        [
            {
                "type": "error",
                "error": {
                    "code": "invalid/api key",
                    "message": "secret provider payload",
                },
            }
        ]
    )

    async def factory(url: str, **kwargs: object) -> FakeSocket:
        return socket

    provider = QwenRealtimeProvider(api_key="secret", websocket_factory=factory)

    with pytest.raises(ProviderError) as raised:
        await provider.connect()

    assert raised.value.reason_code == "qwen_provider_error.invalid_api_key"
    assert "payload" not in str(raised.value)


@pytest.mark.asyncio
async def test_qwen_provider_normalizes_known_cancel_rejection_and_keeps_receiving() -> None:
    socket = FakeSocket(
        [
            {"type": "session.created", "session": {"id": "session-1"}},
            {
                "type": "error",
                "error": {
                    "type": "invalid_request_error",
                    "code": "invalid_value",
                    "message": "No active response found to cancel.",
                },
            },
            {
                "type": "response.done",
                "response": {"id": "response-auto", "status": "completed"},
            },
        ]
    )

    async def factory(url: str, **kwargs: object) -> FakeSocket:
        return socket

    provider = QwenRealtimeProvider(api_key="secret", websocket_factory=factory)
    await provider.connect()

    rejection = await provider.receive()
    terminal = await provider.receive()

    assert rejection == {
        "type": "probe.response_cancel_rejected",
        "reason": "no_active_response",
    }
    assert terminal == {
        "type": "response.done",
        "response": {"id": "response-auto", "status": "completed"},
    }


@pytest.mark.asyncio
async def test_progress_item_is_confirmed_before_manual_response() -> None:
    provider = FakeProvider()
    state = HostState(run_id="run-1", delegate_id="delegate-1", delegate_status="running")
    session = RealtimeProbeSession(provider=provider, state=state)
    await session.connect(turn_detection=None)

    result = await session.inject_progress(
        ScenarioStep(
            "progress-1",
            "progress",
            "Codex 后台已完成页面骨架。",
            {"required_terms": ["页面", "骨架"]},
        ),
        nonce="nonce-1",
    )

    commands = [event["type"] for event in provider.sent]
    assert commands == ["session.update", "conversation.item.create", "response.create"]
    assert result.transcript == "Codex 刚完成了页面骨架。"
    assert state.injected_progress_ids == ["progress-1"]
    assert state.spoken_progress_ids == ["progress-1"]
    item_confirmed = next(
        event for event in session.events if event.kind == "provider.item_created"
    )
    response_created = next(
        event for event in session.events if event.kind == "host.response_create"
    )
    assert item_confirmed.t_ms <= response_created.t_ms


@pytest.mark.asyncio
async def test_recovery_projection_is_injected_once_without_replaying_progress() -> None:
    provider = FakeProvider()
    state = HostState(
        run_id="run-1",
        delegate_id="delegate-1",
        delegate_status="running",
        snapshot_version=4,
        injected_progress_ids=["progress-1", "progress-2"],
        spoken_progress_ids=["progress-2"],
        interrupted_progress_ids=["progress-1"],
        summary="用户委派了俄罗斯方块任务。",
    )
    session = RealtimeProbeSession(provider=provider, state=state)
    await session.connect(turn_detection={"type": "smart_turn"})

    await session.inject_recovery_snapshot()

    created = [event for event in provider.sent if event["type"] == "conversation.item.create"]
    assert len(created) == 1
    item = created[0]["item"]
    assert isinstance(item, dict)
    assert item["role"] == "system"
    text = item["content"][0]["text"]
    assert '"delivered_progress_ids":["progress-2"]' in text
    assert '"interrupted_progress_ids":["progress-1"]' in text
    assert "<nova_progress_event>" not in text


@pytest.mark.asyncio
async def test_barge_in_sends_audio_after_first_delta_without_cancelling_delegate() -> None:
    provider = FakeProvider()
    state = HostState(run_id="run-1", delegate_id="delegate-1", delegate_status="running")
    session = RealtimeProbeSession(provider=provider, state=state)
    await session.connect(turn_detection={"type": "smart_turn"})

    await provider.incoming.put(
        {
            "type": "response.audio_transcript.delta",
            "response_id": "response-progress",
            "delta": "Codex 后台进度：已完成页面骨架。",
        }
    )
    await provider.incoming.put(
        {
            "type": "response.audio.delta",
            "response_id": "response-progress",
            "delta": "AA==",
        }
    )
    await provider.incoming.put(
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "barge-item",
            "transcript": "顺便问一下，七乘八是多少？",
        }
    )
    await provider.incoming.put(
        {
            "type": "response.done",
            "response": {"id": "response-progress", "status": "cancelled"},
        }
    )
    await provider.incoming.put(
        {
            "type": "response.audio_transcript.done",
            "response_id": "response-foreground",
            "transcript": "七乘八等于五十六。",
        }
    )
    await provider.incoming.put(
        {
            "type": "response.done",
            "response": {"id": "response-foreground", "status": "completed"},
        }
    )

    result = await session.collect_barge_in(b"\x00\x00" * 1600)

    assert result.transcript == "七乘八等于五十六。"
    assert any(event["type"] == "input_audio_buffer.append" for event in provider.sent)
    assert any(event.kind == "host.barge_in_sent" for event in session.events)
    assert not any(event.kind == "host.delegate_cancelled" for event in session.events)
    assert any(
        event.kind == "assistant.transcript"
        and event.data.get("purpose") == "progress"
        and "页面骨架" in str(event.data.get("text"))
        for event in session.events
    )
    assert any(event.kind == "host.progress_spoken" for event in session.events)
    assert state.delegate_status == "running"


@pytest.mark.asyncio
async def test_smart_turn_stream_appends_one_second_of_silence() -> None:
    provider = FakeProvider()
    state = HostState(run_id="run-1", delegate_id="delegate-1")
    session = RealtimeProbeSession(provider=provider, state=state, pace_audio=False)
    await session.connect(turn_detection={"type": "smart_turn"})
    provider.sent.clear()

    await session.stream_audio(b"\x01\x00" * 1600)

    appends = [event for event in provider.sent if event["type"] == "input_audio_buffer.append"]
    assert len(appends) == 11
    assert base64.b64decode(appends[0]["audio"]) == b"\x01\x00" * 1600
    assert base64.b64decode(appends[-1]["audio"]) == b"\x00" * 3200


@pytest.mark.asyncio
async def test_interruption_audio_uses_20ms_chunks_and_one_second_silence() -> None:
    provider = FakeProvider()
    state = HostState(run_id="run-1", delegate_id="delegate-1")
    session = RealtimeProbeSession(provider=provider, state=state, pace_audio=False)
    await session.connect(turn_detection={"type": "smart_turn"})
    provider.sent.clear()

    await session.stream_interruption_audio(b"\x01\x00" * 640)

    appends = [event for event in provider.sent if event["type"] == "input_audio_buffer.append"]
    assert [len(base64.b64decode(event["audio"])) for event in appends[:2]] == [640, 640]
    assert len(appends) == 52
    assert base64.b64decode(appends[-1]["audio"]) == b"\x00" * 640


@pytest.mark.asyncio
async def test_push_to_talk_stream_does_not_append_silence() -> None:
    provider = FakeProvider()
    state = HostState(run_id="run-1", delegate_id="delegate-1")
    session = RealtimeProbeSession(provider=provider, state=state, pace_audio=False)
    await session.connect(turn_detection=None)
    provider.sent.clear()

    await session.stream_audio(b"\x01\x00" * 1600)

    appends = [event for event in provider.sent if event["type"] == "input_audio_buffer.append"]
    assert len(appends) == 1


@pytest.mark.asyncio
async def test_barge_in_completion_is_semantic_evidence_not_a_harness_error() -> None:
    provider = FakeProvider()
    state = HostState(run_id="run-1", delegate_id="delegate-1", delegate_status="running")
    session = RealtimeProbeSession(provider=provider, state=state, pace_audio=False)
    await session.connect(turn_detection={"type": "smart_turn"})

    for event in (
        {
            "type": "response.audio_transcript.delta",
            "response_id": "response-progress",
            "delta": "Codex 后台进度：已完成页面骨架。",
        },
        {
            "type": "response.audio.delta",
            "response_id": "response-progress",
            "delta": "AAA=",
        },
        {
            "type": "response.done",
            "response": {"id": "response-progress", "status": "completed"},
        },
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "barge-item",
            "transcript": "顺便问一下，七乘八是多少？",
        },
        {
            "type": "response.audio_transcript.done",
            "response_id": "response-foreground",
            "transcript": "七乘八等于五十六。",
        },
        {
            "type": "response.done",
            "response": {"id": "response-foreground", "status": "completed"},
        },
    ):
        await provider.incoming.put(event)

    foreground = await session.collect_barge_in(b"\x00\x00" * 16)

    assert foreground.transcript == "七乘八等于五十六。"
    assert any(event.kind == "host.barge_in_sent" for event in session.events)
    assert not any(event.kind == "provider.response_cancelled" for event in session.events)
    assert any(
        event.kind == "provider.response_done"
        and event.data.get("purpose") == "progress"
        and event.data.get("cause_event_id") == "progress-1"
        for event in session.events
    )
