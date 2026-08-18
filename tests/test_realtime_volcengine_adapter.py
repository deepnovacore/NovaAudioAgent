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
    UserTranscriptFailed,
    UserTranscriptFinal,
)
from nova_audio_agent.realtime.qwen import GUARD_ACTIVATION_PREFIX
import nova_audio_agent.realtime.volcengine.adapter as adapter_module
from nova_audio_agent.realtime.volcengine.adapter import (
    VolcengineCascadedAdapter,
    VolcengineRealtimeError,
    _host_input,
)
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


class _TwoTurnVad(_Vad):
    def feed(self, pcm: bytes) -> tuple[VadEvent, ...]:
        call = self.calls
        self.calls += 1
        if call in {0, 2}:
            self.in_speech = True
            return (VadEvent("speech_started", pre_roll_pcm=pcm),)
        self.in_speech = False
        return (VadEvent("speech_stopped", speech_ms=500, commit=True),)


class _OnsetPacketVad(_Vad):
    def feed(self, pcm: bytes) -> tuple[VadEvent, ...]:
        self.in_speech = True
        return (
            VadEvent(
                "speech_started",
                pre_roll_pcm=pcm[: len(pcm) // 2],
                speech_pcm=pcm[len(pcm) // 2 :],
            ),
        )


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


class _EmptyFinalAsrSession(_AsrSession):
    async def events(self) -> AsyncIterator[AsrTranscript]:
        await self.finished.wait()
        yield AsrTranscript("", True)


class _EmptyFinalAsr(_Asr):
    def __init__(self) -> None:
        self.session = _EmptyFinalAsrSession()


class _FailOnceAsr(_Asr):
    def __init__(self) -> None:
        super().__init__()
        self.opens = 0

    async def open(self) -> _AsrSession:
        self.opens += 1
        if self.opens == 1:
            raise ConnectionError("credential-must-not-leak")
        return self.session


class _FailFinishAsrSession(_AsrSession):
    async def finish(self) -> None:
        raise ConnectionError("credential-must-not-leak")


class _FailFinishAsr(_Asr):
    def __init__(self) -> None:
        self.session = _FailFinishAsrSession()


class _FailAppendAsrSession(_AsrSession):
    def __init__(self) -> None:
        super().__init__()
        self.append_calls = 0

    async def append(self, pcm: bytes) -> None:
        self.append_calls += 1
        if self.append_calls == 2:
            raise ConnectionError("credential-must-not-leak")
        await super().append(pcm)


class _FailAppendAsr(_Asr):
    def __init__(self) -> None:
        self.session = _FailAppendAsrSession()


class _FailReceiveAsrSession(_AsrSession):
    async def events(self) -> AsyncIterator[AsrTranscript]:
        raise ConnectionError("credential-must-not-leak")
        yield AsrTranscript("", True)


class _FailReceiveAsr(_Asr):
    def __init__(self) -> None:
        self.session = _FailReceiveAsrSession()


class _HangingAsrSession(_AsrSession):
    def __init__(self) -> None:
        super().__init__()
        self.closed = False

    async def events(self) -> AsyncIterator[AsrTranscript]:
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    async def close(self) -> None:
        self.closed = True


class _SequencedAsr(_Asr):
    def __init__(self) -> None:
        self.first = _HangingAsrSession()
        self.second = _AsrSession()
        self.sessions = iter((self.first, self.second))

    async def open(self) -> _AsrSession:
        return next(self.sessions)


class _Ark:
    def __init__(self, events: list[Any]) -> None:
        self.events = events
        self.calls: list[dict[str, Any]] = []

    def stream(self, **kwargs: Any) -> AsyncIterator[Any]:
        self.calls.append(kwargs)
        return _iterate(self.events)


class _SequencedArk(_Ark):
    def __init__(self, event_sets: list[list[Any]]) -> None:
        super().__init__([])
        self._event_sets = iter(event_sets)

    def stream(self, **kwargs: Any) -> AsyncIterator[Any]:
        self.calls.append(kwargs)
        return _iterate(next(self._event_sets))


class _BlockingArk:
    def __init__(self) -> None:
        self.waiting = asyncio.Event()

    async def stream(self, **kwargs: Any) -> AsyncIterator[Any]:
        del kwargs
        yield ArkResponseStarted("response-cancel")
        yield ArkTextDelta("还在生成，")
        self.waiting.set()
        await asyncio.Event().wait()


class _PrewarmArk:
    def __init__(self) -> None:
        self.response_started = asyncio.Event()
        self.release_text = asyncio.Event()

    async def stream(self, **_kwargs: Any) -> AsyncIterator[Any]:
        yield ArkResponseStarted("response-prewarm")
        self.response_started.set()
        await self.release_text.wait()
        yield ArkTextDelta("你好。")
        yield ArkResponseCompleted("response-prewarm")


class _DelayedToolArk:
    async def stream(self, **_kwargs: Any) -> AsyncIterator[Any]:
        yield ArkResponseStarted("response-tool")
        await asyncio.sleep(0)
        yield ArkToolCall("item-tool", "call-tool", "weather__get", {"city": "上海"})
        yield ArkResponseCompleted("response-tool")


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


class _ImmediateReceiveFailureSession(_TtsSession):
    async def events(self) -> AsyncIterator[TtsAudio]:
        if False:
            yield TtsAudio(b"")
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


async def _collect_until(
    adapter: VolcengineCascadedAdapter,
    expected_type: type[Any],
) -> list[Any]:
    events: list[Any] = []
    async for event in adapter.events():
        events.append(event)
        if isinstance(event, expected_type):
            return events
    raise AssertionError("adapter event stream ended before expected event")


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


def test_guard_activation_uses_the_shared_qwen_disclaimer_prefix() -> None:
    item = HostContextItem.progress(
        host_item_id="progress-1",
        event_id="event-1",
        content="任务仍在运行",
    )

    payload = _host_input(item, as_user_activation=True)

    assert payload["role"] == "user"
    assert payload["content"].startswith(GUARD_ACTIVATION_PREFIX)
    assert "不是用户说的话，也不是新的用户目标" in payload["content"]


@pytest.mark.asyncio
async def test_asr_append_failure_ends_the_floor_without_raising() -> None:
    adapter = VolcengineCascadedAdapter(
        vad=_OnsetPacketVad(),
        asr=_FailAppendAsr(),
        ark=_Ark([]),
        tts=_Tts(),
        id_factory=iter(("session", "speech", "item")).__next__,
    )
    await adapter.connect(tools=_tools())

    await adapter.send_audio(b"pre-roll-and-onset")

    events = await asyncio.wait_for(_collect_until(adapter, UserTranscriptFailed), timeout=1)
    assert any(isinstance(event, UserSpeechStarted) for event in events)
    assert any(isinstance(event, UserSpeechEnded) for event in events)
    assert any(
        isinstance(event, ProviderErrorEvent) and event.code == "volcengine_asr_append"
        for event in events
    )
    assert adapter._asr_session is None


@pytest.mark.asyncio
async def test_asr_receive_failure_still_ends_the_floor_on_vad_stop() -> None:
    adapter = VolcengineCascadedAdapter(
        vad=_Vad(), asr=_FailReceiveAsr(), ark=_Ark([]), tts=_Tts(), id_factory=lambda: "id"
    )
    await adapter.connect(tools=_tools())

    await adapter.send_audio(b"first")
    await asyncio.sleep(0)
    await adapter.send_audio(b"stop")

    events = await asyncio.wait_for(_collect_until(adapter, UserSpeechEnded), timeout=1)
    assert sum(isinstance(event, UserSpeechEnded) for event in events) == 1
    assert any(isinstance(event, UserTranscriptFailed) for event in events)


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
async def test_adapter_prewarms_tts_before_the_first_text_delta() -> None:
    ark = _PrewarmArk()
    tts = _Tts()
    adapter = VolcengineCascadedAdapter(
        vad=_Vad(), asr=_Asr(), ark=ark, tts=tts, id_factory=lambda: "id"
    )
    await adapter.connect(tools=_tools())
    item = HostContextItem.progress(host_item_id="progress-1", event_id="event-1", content="上下文")
    await adapter.inject_host_item(item)
    await adapter.create_response(HostResponseIntent.host_fact(item))

    await asyncio.wait_for(ark.response_started.wait(), timeout=1)

    assert len(tts.sessions) == 1
    assert tts.sessions[0].texts == []

    collector = asyncio.create_task(_collect_until_terminal(adapter))
    ark.release_text.set()
    await asyncio.wait_for(collector, timeout=1)

    assert tts.sessions[0].texts == ["你好。"]


@pytest.mark.asyncio
async def test_blank_asr_final_emits_failed_terminal_instead_of_waiting_for_response() -> None:
    adapter = VolcengineCascadedAdapter(
        vad=_Vad(),
        asr=_EmptyFinalAsr(),
        ark=_Ark([]),
        tts=_Tts(),
        id_factory=lambda: "id",
    )
    await adapter.connect(tools=_tools())
    collector = asyncio.create_task(_collect_until(adapter, UserTranscriptFailed))

    await adapter.send_audio(b"\x00\x00" * 512)
    await adapter.send_audio(b"\x00\x00" * 512)
    events = await asyncio.wait_for(collector, timeout=1)

    assert any(isinstance(event, UserTranscriptFailed) for event in events)
    assert not any(isinstance(event, UserTranscriptFinal) for event in events)


@pytest.mark.asyncio
async def test_asr_start_failure_is_recoverable_on_a_later_utterance() -> None:
    ark = _Ark(
        [ArkResponseStarted("recovered"), ArkTextDelta("恢复。"), ArkResponseCompleted("recovered")]
    )
    asr = _FailOnceAsr()
    adapter = VolcengineCascadedAdapter(
        vad=_TwoTurnVad(), asr=asr, ark=ark, tts=_Tts(), id_factory=lambda: "id"
    )
    await adapter.connect(tools=_tools())
    collector = asyncio.create_task(_collect_until_terminal(adapter))

    await adapter.send_audio(b"\x00\x00" * 512)
    await adapter.send_audio(b"\x00\x00" * 512)
    await adapter.send_audio(b"\x00\x00" * 512)
    await adapter.send_audio(b"\x00\x00" * 512)
    events = await asyncio.wait_for(collector, timeout=1)

    assert asr.opens == 2
    assert any(isinstance(event, ProviderErrorEvent) for event in events)
    assert events[-1].status == "completed"


@pytest.mark.asyncio
async def test_asr_finish_failure_emits_a_failed_transcript_without_escaping_send_audio() -> None:
    adapter = VolcengineCascadedAdapter(
        vad=_Vad(), asr=_FailFinishAsr(), ark=_Ark([]), tts=_Tts(), id_factory=lambda: "id"
    )
    await adapter.connect(tools=_tools())
    collector = asyncio.create_task(_collect_until(adapter, UserTranscriptFailed))

    await adapter.send_audio(b"\x00\x00" * 512)
    await adapter.send_audio(b"\x00\x00" * 512)
    events = await asyncio.wait_for(collector, timeout=1)

    assert any(
        isinstance(event, ProviderErrorEvent) and event.code == "volcengine_asr_finish"
        for event in events
    )
    assert any(isinstance(event, UserTranscriptFailed) for event in events)
    assert adapter._asr_session is None


@pytest.mark.asyncio
async def test_onset_packet_audio_after_pre_roll_is_forwarded_to_asr() -> None:
    asr = _Asr()
    adapter = VolcengineCascadedAdapter(
        vad=_OnsetPacketVad(), asr=asr, ark=_Ark([]), tts=_Tts(), id_factory=lambda: "id"
    )
    await adapter.connect(tools=_tools())
    pcm = b"\x01\x00" * 1_024

    await adapter.send_audio(pcm)

    assert asr.session.audio == [pcm[: len(pcm) // 2], pcm[len(pcm) // 2 :]]


@pytest.mark.asyncio
async def test_new_onset_replaces_an_asr_session_still_draining_its_final() -> None:
    ark = _Ark(
        [ArkResponseStarted("second"), ArkTextDelta("第二轮。"), ArkResponseCompleted("second")]
    )
    asr = _SequencedAsr()
    adapter = VolcengineCascadedAdapter(
        vad=_TwoTurnVad(), asr=asr, ark=ark, tts=_Tts(), id_factory=lambda: "id"
    )
    await adapter.connect(tools=_tools())
    collector = asyncio.create_task(_collect_until_terminal(adapter))

    for _ in range(4):
        await adapter.send_audio(b"\x00\x00" * 512)
    events = await asyncio.wait_for(collector, timeout=1)

    assert asr.first.closed is True
    assert events[-1].response_id == "second"
    assert events[-1].status == "completed"


@pytest.mark.asyncio
async def test_adapter_cancels_preheated_tts_for_a_tool_only_response() -> None:
    ark = _DelayedToolArk()
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
    assert len(tts.sessions) == 1
    assert tts.sessions[0].texts == []
    assert tts.sessions[0].cancelled is True
    assert not any(isinstance(event, ResponseAudioDelta) for event in events)


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
async def test_host_responses_consume_only_the_item_named_by_the_intent() -> None:
    ark = _Ark([ArkResponseStarted("host-response"), ArkResponseCompleted("host-response")])
    adapter = VolcengineCascadedAdapter(
        vad=_Vad(), asr=_Asr(), ark=ark, tts=_Tts(), id_factory=lambda: "id"
    )
    await adapter.connect(tools=_tools())
    first = HostContextItem.progress(
        host_item_id="progress-1",
        event_id="event-1",
        content="第一项",
    )
    second = HostContextItem.progress(
        host_item_id="progress-2",
        event_id="event-2",
        content="第二项",
    )
    await adapter.inject_host_item(first)
    await adapter.inject_host_item(second)

    await adapter.create_response(HostResponseIntent.host_fact(first))
    await asyncio.wait_for(_collect_until_terminal(adapter), timeout=1)
    assert adapter._response_task is not None
    await adapter._response_task

    await adapter.create_response(HostResponseIntent.host_fact(second))
    await asyncio.wait_for(_collect_until_terminal(adapter), timeout=1)

    assert len(ark.calls) == 2
    assert [item["content"] for item in ark.calls[0]["input_items"]] == [
        "Nova Audio Agent 任务进度事实：第一项"
    ]
    assert [item["content"] for item in ark.calls[1]["input_items"]] == [
        "Nova Audio Agent 任务进度事实：第二项"
    ]


@pytest.mark.asyncio
async def test_satisfying_one_batched_host_item_keeps_the_other_item_available() -> None:
    adapter = VolcengineCascadedAdapter(
        vad=_Vad(),
        asr=_Asr(),
        ark=_Ark([ArkResponseStarted("user-response"), ArkResponseCompleted("user-response")]),
        tts=_Tts(),
        id_factory=lambda: "id",
    )
    await adapter.connect(tools=_tools())
    first = HostContextItem.recovery(host_item_id="first", event_id="event-first", content="第一项")
    second = HostContextItem.tool_output(
        host_item_id="second",
        event_id="event-second",
        call_id="call-second",
        content="第二项",
    )
    await adapter.inject_host_item(first)
    await adapter.inject_host_item(second)
    await adapter._start_user_response("用户插话")
    await asyncio.wait_for(_collect_until_terminal(adapter), timeout=1)

    await adapter.create_response(HostResponseIntent.host_fact(first))
    await asyncio.wait_for(_collect_until_terminal(adapter), timeout=1)
    await adapter.create_response(HostResponseIntent.tool_result(second))
    events = await asyncio.wait_for(_collect_until_terminal(adapter), timeout=1)

    assert events[-1].status == "completed"


@pytest.mark.asyncio
async def test_host_item_injection_rejects_capacity_exhaustion_without_dropping_prior_items(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(adapter_module, "_MAX_PENDING_HOST_ITEMS", 1)
    adapter = VolcengineCascadedAdapter(
        vad=_Vad(), asr=_Asr(), ark=_Ark([]), tts=_Tts(), id_factory=lambda: "id"
    )
    await adapter.connect(tools=_tools())
    first = HostContextItem.progress(host_item_id="first", event_id="event-first", content="第一项")
    second = HostContextItem.progress(
        host_item_id="second", event_id="event-second", content="第二项"
    )

    await adapter.inject_host_item(first)
    with pytest.raises(VolcengineRealtimeError, match="宿主项积压"):
        await adapter.inject_host_item(second)

    assert tuple(adapter._pending_items) == ("first",)


@pytest.mark.asyncio
async def test_user_interrupt_carries_pending_context_and_tool_output_without_duplicate_continuation() -> (
    None
):
    ark = _Ark(
        [
            ArkResponseStarted("user-response"),
            ArkTextDelta("收到。"),
            ArkResponseCompleted("user-response"),
        ]
    )
    adapter = VolcengineCascadedAdapter(
        vad=_Vad(), asr=_Asr(), ark=ark, tts=_Tts(), id_factory=lambda: "silent-response"
    )
    await adapter.connect(tools=_tools())
    adapter._previous_response_id = "function-response"
    recovery = HostContextItem.recovery(
        host_item_id="recovery-1",
        event_id="event-recovery",
        content="有界恢复事实",
    )
    tool_output = HostContextItem.tool_output(
        host_item_id="tool-output-1",
        event_id="event-tool",
        call_id="call-tool",
        content='{"condition":"晴"}',
    )
    await adapter.inject_host_item(recovery)
    await adapter.inject_host_item(tool_output)

    await adapter._start_user_response("再补充一个条件")
    await asyncio.wait_for(_collect_until_terminal(adapter), timeout=1)
    assert adapter._response_task is not None
    await adapter._response_task

    await adapter.create_response(HostResponseIntent.tool_result(tool_output))
    silent_events = await asyncio.wait_for(_collect_until_terminal(adapter), timeout=1)

    assert ark.calls == [
        {
            "input_items": [
                {"role": "system", "content": "Nova Audio Agent 恢复摘要：有界恢复事实"},
                {
                    "type": "function_call_output",
                    "call_id": "call-tool",
                    "output": '{"condition":"晴"}',
                },
                {"role": "user", "content": "再补充一个条件"},
            ],
            "tools": adapter._tools,
            "previous_response_id": "function-response",
        }
    ]
    assert any(isinstance(event, ResponseStarted) for event in silent_events)
    assert silent_events[-1].status == "completed"


@pytest.mark.asyncio
async def test_user_barge_in_drops_unresolved_tool_response_chain() -> None:
    ark = _SequencedArk(
        [
            [
                ArkResponseStarted("function-response"),
                ArkToolCall("item-tool", "call-tool", "weather__get", {"city": "上海"}),
                ArkResponseCompleted("function-response"),
            ],
            [ArkResponseStarted("user-response"), ArkResponseCompleted("user-response")],
        ]
    )
    adapter = VolcengineCascadedAdapter(
        vad=_Vad(), asr=_Asr(), ark=ark, tts=_Tts(), id_factory=lambda: "id"
    )
    await adapter.connect(tools=_tools())

    await adapter._run_ark([])
    await asyncio.wait_for(_collect_until_terminal(adapter), timeout=1)
    await adapter._start_user_response("先不要执行，换个问题")
    await asyncio.wait_for(_collect_until_terminal(adapter), timeout=1)

    assert ark.calls[1]["previous_response_id"] is None


@pytest.mark.asyncio
async def test_late_tool_output_after_barge_in_is_consumed_without_ark_continuation() -> None:
    ark = _SequencedArk(
        [
            [
                ArkResponseStarted("function-response"),
                ArkToolCall("item-tool", "call-tool", "weather__get", {"city": "上海"}),
                ArkResponseCompleted("function-response"),
            ],
            [ArkResponseStarted("user-response"), ArkResponseCompleted("user-response")],
        ]
    )
    adapter = VolcengineCascadedAdapter(
        vad=_Vad(), asr=_Asr(), ark=ark, tts=_Tts(), id_factory=lambda: "id"
    )
    await adapter.connect(tools=_tools())
    await adapter._run_ark([])
    await asyncio.wait_for(_collect_until_terminal(adapter), timeout=1)
    await adapter._start_user_response("先不要执行，换个问题")
    await asyncio.wait_for(_collect_until_terminal(adapter), timeout=1)
    output = HostContextItem.tool_output(
        host_item_id="late-output",
        event_id="late-event",
        call_id="call-tool",
        content='{"condition":"晴"}',
    )
    await adapter.inject_host_item(output)

    await adapter.create_response(HostResponseIntent.tool_result(output))
    events = await asyncio.wait_for(_collect_until_terminal(adapter), timeout=1)

    assert len(ark.calls) == 2
    assert events[-1].status == "completed"


@pytest.mark.asyncio
async def test_mixed_tool_then_text_never_exposes_the_tool_to_the_host() -> None:
    ark = _Ark(
        [
            ArkResponseStarted("mixed"),
            ArkToolCall("item-tool", "call-tool", "weather__get", {"city": "上海"}),
            ArkTextDelta("我来查询天气。"),
        ]
    )
    adapter = VolcengineCascadedAdapter(
        vad=_Vad(), asr=_Asr(), ark=ark, tts=_Tts(), id_factory=lambda: "id"
    )
    await adapter.connect(tools=_tools())

    await adapter._start_user_response("上海天气")
    events = await asyncio.wait_for(_collect_until_terminal(adapter), timeout=1)

    assert not any(isinstance(event, ToolCallReady) for event in events)
    assert any(isinstance(event, ProviderErrorEvent) for event in events)
    assert events[-1].status == "failed"


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
async def test_cancelling_tts_retrieves_an_already_failed_consumer_and_reports_it() -> None:
    adapter = VolcengineCascadedAdapter(
        vad=_Vad(), asr=_Asr(), ark=_Ark([]), tts=_Tts(), id_factory=lambda: "id"
    )
    await adapter.connect(tools=_tools())
    session = _ImmediateReceiveFailureSession()
    adapter._tts_session = session
    adapter._tts_task = asyncio.create_task(adapter._consume_tts("response-1", session))
    await asyncio.sleep(0)
    assert adapter._tts_task.done()

    await adapter._cancel_tts()
    events = await asyncio.wait_for(_collect_until(adapter, ProviderErrorEvent), timeout=1)

    error = next(event for event in events if isinstance(event, ProviderErrorEvent))
    assert error == ProviderErrorEvent(1, "volcengine_tts_receive", True)


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
