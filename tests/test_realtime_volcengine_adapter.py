from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest

from nova_audio_agent.realtime.protocol import (
    HostContextItem,
    HostResponseIntent,
    ProviderErrorEvent,
    ResponseAudioDelta,
    ResponseStarted,
    ResponseTerminal,
    ResponseTranscriptFinal,
    ToolCallReady,
    UserSpeechEnded,
    UserSpeechStarted,
    UserTranscriptFinal,
)
from nova_audio_agent.realtime.volcengine.adapter import VolcengineCascadedAdapter
from nova_audio_agent.realtime.volcengine.ark import (
    ArkResponseCompleted,
    ArkResponseStarted,
    ArkTextDelta,
    ArkToolCall,
)
from nova_audio_agent.realtime.volcengine.asr import AsrTranscript
from nova_audio_agent.realtime.volcengine.tts import TtsAudio
from nova_audio_agent.realtime.volcengine.vad import VadEvent


async def _iterate(values: list[Any]) -> AsyncIterator[Any]:
    for value in values:
        yield value


class _Vad:
    def __init__(self) -> None:
        self.in_speech = False
        self.calls = 0

    def feed(self, pcm: bytes) -> tuple[VadEvent, ...]:
        self.calls += 1
        if self.calls == 1:
            self.in_speech = True
            return (VadEvent("speech_started", pre_roll_pcm=pcm),)
        self.in_speech = False
        return (VadEvent("speech_stopped", speech_ms=500, commit=True),)

    def reset(self) -> None:
        self.in_speech = False


class _AsrSession:
    def __init__(self) -> None:
        self.audio: list[bytes] = []
        self.finished = asyncio.Event()

    async def append(self, pcm: bytes) -> None:
        self.audio.append(pcm)

    async def finish(self) -> None:
        self.finished.set()

    async def events(self) -> AsyncIterator[AsrTranscript]:
        await self.finished.wait()
        yield AsrTranscript("你好", False)
        yield AsrTranscript("你好 Nova", True)

    async def close(self) -> None:
        return None


class _Asr:
    def __init__(self) -> None:
        self.session = _AsrSession()

    async def open(self) -> _AsrSession:
        return self.session


class _Ark:
    def __init__(self, events: list[Any]) -> None:
        self.events = events
        self.calls: list[dict[str, Any]] = []

    def stream(self, **kwargs: Any) -> AsyncIterator[Any]:
        self.calls.append(kwargs)
        return _iterate(self.events)


class _BlockingArk:
    def __init__(self) -> None:
        self.waiting = asyncio.Event()

    async def stream(self, **kwargs: Any) -> AsyncIterator[Any]:
        del kwargs
        yield ArkResponseStarted("response-cancel")
        yield ArkTextDelta("还在生成，")
        self.waiting.set()
        await asyncio.Event().wait()


class _TtsSession:
    def __init__(self) -> None:
        self.texts: list[str] = []
        self.finished = asyncio.Event()
        self.cancelled = False

    async def send_text(self, text: str) -> None:
        self.texts.append(text)

    async def finish(self) -> None:
        self.finished.set()

    async def cancel(self) -> None:
        self.cancelled = True
        self.finished.set()

    async def events(self) -> AsyncIterator[TtsAudio]:
        await self.finished.wait()
        if not self.cancelled:
            yield TtsAudio(b"\x01\x02")

    async def close(self) -> None:
        return None


class _Tts:
    def __init__(self) -> None:
        self.sessions: list[_TtsSession] = []

    async def open(self) -> _TtsSession:
        session = _TtsSession()
        self.sessions.append(session)
        return session


class _FailBeforeAudioSession(_TtsSession):
    async def send_text(self, text: str) -> None:
        del text
        raise ConnectionError("credential-must-not-leak")


class _FailAfterAudioSession(_TtsSession):
    async def events(self) -> AsyncIterator[TtsAudio]:
        yield TtsAudio(b"\x05\x06")
        raise ConnectionError("credential-must-not-leak")


class _SequencedTts:
    def __init__(self, sessions: list[_TtsSession]) -> None:
        self.sessions = sessions
        self.open_count = 0

    async def open(self) -> _TtsSession:
        session = self.sessions[self.open_count]
        self.open_count += 1
        return session


async def _collect_until_terminal(adapter: VolcengineCascadedAdapter) -> list[Any]:
    events: list[Any] = []
    async for event in adapter.events():
        events.append(event)
        if isinstance(event, ResponseTerminal):
            return events
    raise AssertionError("adapter event stream ended without terminal")


def _tools() -> tuple[dict[str, Any], ...]:
    return (
        {
            "type": "function",
            "function": {
                "name": "weather__get",
                "description": "天气",
                "parameters": {"type": "object", "properties": {}},
            },
        },
    )


@pytest.mark.asyncio
async def test_adapter_runs_vad_asr_ark_tts_and_emits_normalized_events() -> None:
    ark = _Ark(
        [
            ArkResponseStarted("response-1"),
            ArkTextDelta("你好，"),
            ArkTextDelta("很高兴见到你。"),
            ArkResponseCompleted("response-1"),
        ]
    )
    tts = _Tts()
    adapter = VolcengineCascadedAdapter(
        vad=_Vad(),
        asr=_Asr(),
        ark=ark,
        tts=tts,
        id_factory=iter(("session-1", "speech-1", "item-1")).__next__,
    )
    identity = await adapter.connect(tools=_tools())
    collector = asyncio.create_task(_collect_until_terminal(adapter))

    await adapter.send_audio(b"\x00\x00" * 512)
    await adapter.send_audio(b"\x00\x00" * 512)
    events = await asyncio.wait_for(collector, timeout=1)

    assert identity.provider_session_id == "session-1"
    assert any(isinstance(event, UserSpeechStarted) for event in events)
    assert any(isinstance(event, UserSpeechEnded) for event in events)
    assert any(
        isinstance(event, UserTranscriptFinal) and event.text == "你好 Nova" for event in events
    )
    assert any(isinstance(event, ResponseStarted) for event in events)
    assert any(isinstance(event, ResponseAudioDelta) for event in events)
    assert any(isinstance(event, ResponseTranscriptFinal) for event in events)
    assert events[-1] == ResponseTerminal(1, "response-1", "completed", "completed")
    assert tts.sessions[0].texts == ["你好，", "很高兴见到你。"]


@pytest.mark.asyncio
async def test_adapter_emits_tool_call_without_opening_tts() -> None:
    ark = _Ark(
        [
            ArkResponseStarted("response-tool"),
            ArkToolCall("item-tool", "call-tool", "weather__get", {"city": "上海"}),
            ArkResponseCompleted("response-tool"),
        ]
    )
    tts = _Tts()
    adapter = VolcengineCascadedAdapter(
        vad=_Vad(), asr=_Asr(), ark=ark, tts=tts, id_factory=lambda: "id"
    )
    await adapter.connect(tools=_tools())
    collector = asyncio.create_task(_collect_until_terminal(adapter))

    await adapter.send_audio(b"\x00\x00" * 512)
    await adapter.send_audio(b"\x00\x00" * 512)
    events = await asyncio.wait_for(collector, timeout=1)

    assert any(isinstance(event, ToolCallReady) for event in events)
    assert tts.sessions == []


@pytest.mark.asyncio
async def test_adapter_rejects_mixed_text_and_tool_call_without_dispatching_tool() -> None:
    ark = _Ark(
        [
            ArkResponseStarted("response-mixed"),
            ArkTextDelta("我来查一下，"),
            ArkToolCall("item-tool", "call-tool", "weather__get", {}),
            ArkResponseCompleted("response-mixed"),
        ]
    )
    adapter = VolcengineCascadedAdapter(
        vad=_Vad(), asr=_Asr(), ark=ark, tts=_Tts(), id_factory=lambda: "id"
    )
    await adapter.connect(tools=_tools())
    collector = asyncio.create_task(_collect_until_terminal(adapter))

    await adapter.send_audio(b"\x00\x00" * 512)
    await adapter.send_audio(b"\x00\x00" * 512)
    events = await asyncio.wait_for(collector, timeout=1)

    assert not any(isinstance(event, ToolCallReady) for event in events)
    assert any(isinstance(event, ProviderErrorEvent) for event in events)
    assert events[-1].status == "failed"


@pytest.mark.asyncio
async def test_tool_output_is_submitted_as_function_call_output_on_continuation() -> None:
    ark = _Ark(
        [
            ArkResponseStarted("continuation"),
            ArkTextDelta("晴天。"),
            ArkResponseCompleted("continuation"),
        ]
    )
    adapter = VolcengineCascadedAdapter(
        vad=_Vad(), asr=_Asr(), ark=ark, tts=_Tts(), id_factory=lambda: "host-id"
    )
    await adapter.connect(tools=_tools())
    item = HostContextItem.tool_output(
        host_item_id="host-item",
        event_id="event-1",
        call_id="call-tool",
        content='{"condition":"晴"}',
    )

    identity = await adapter.inject_host_item(item)
    collector = asyncio.create_task(_collect_until_terminal(adapter))
    await adapter.create_response(HostResponseIntent.tool_result(item))
    await asyncio.wait_for(collector, timeout=1)

    assert identity.host_item_id == "host-item"
    assert ark.calls[0]["input_items"] == [
        {
            "type": "function_call_output",
            "call_id": "call-tool",
            "output": '{"condition":"晴"}',
        }
    ]


@pytest.mark.asyncio
async def test_tts_reconnects_once_when_current_text_has_not_emitted_audio() -> None:
    ark = _Ark([ArkResponseStarted("retry"), ArkTextDelta("你好。"), ArkResponseCompleted("retry")])
    good = _TtsSession()
    tts = _SequencedTts([_FailBeforeAudioSession(), good])
    adapter = VolcengineCascadedAdapter(
        vad=_Vad(), asr=_Asr(), ark=ark, tts=tts, id_factory=lambda: "id"
    )
    await adapter.connect(tools=_tools())
    collector = asyncio.create_task(_collect_until_terminal(adapter))

    await adapter.send_audio(b"\x00\x00" * 512)
    await adapter.send_audio(b"\x00\x00" * 512)
    events = await asyncio.wait_for(collector, timeout=1)

    assert tts.open_count == 2
    assert good.texts == ["你好。"]
    assert any(isinstance(event, ResponseAudioDelta) for event in events)
    assert events[-1].status == "completed"


@pytest.mark.asyncio
async def test_tts_does_not_retry_after_any_audio_was_emitted() -> None:
    ark = _Ark(
        [ArkResponseStarted("no-retry"), ArkTextDelta("你好。"), ArkResponseCompleted("no-retry")]
    )
    tts = _SequencedTts([_FailAfterAudioSession(), _TtsSession()])
    adapter = VolcengineCascadedAdapter(
        vad=_Vad(), asr=_Asr(), ark=ark, tts=tts, id_factory=lambda: "id"
    )
    await adapter.connect(tools=_tools())
    collector = asyncio.create_task(_collect_until_terminal(adapter))

    await adapter.send_audio(b"\x00\x00" * 512)
    await adapter.send_audio(b"\x00\x00" * 512)
    events = await asyncio.wait_for(collector, timeout=1)

    assert tts.open_count == 1
    assert any(isinstance(event, ResponseAudioDelta) for event in events)
    assert events[-1].status == "failed"


@pytest.mark.asyncio
async def test_cancel_response_stops_ark_tts_and_discards_late_audio() -> None:
    ark = _BlockingArk()
    tts = _Tts()
    adapter = VolcengineCascadedAdapter(
        vad=_Vad(), asr=_Asr(), ark=ark, tts=tts, id_factory=lambda: "id"
    )
    await adapter.connect(tools=_tools())
    collector = asyncio.create_task(_collect_until_terminal(adapter))

    await adapter.send_audio(b"\x00\x00" * 512)
    await adapter.send_audio(b"\x00\x00" * 512)
    await asyncio.wait_for(ark.waiting.wait(), timeout=1)
    await adapter.cancel_response("response-cancel")
    events = await asyncio.wait_for(collector, timeout=1)

    assert tts.sessions[0].cancelled is True
    assert not any(isinstance(event, ResponseAudioDelta) for event in events)
    assert events[-1] == ResponseTerminal(1, "response-cancel", "cancelled", "cancelled")
