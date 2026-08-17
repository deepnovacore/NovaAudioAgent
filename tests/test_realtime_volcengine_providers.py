from __future__ import annotations

import asyncio
import gzip
import json
import struct
from types import SimpleNamespace
from typing import Any

import pytest

from nova_audio_agent.realtime.volcengine.ark import (
    ArkResponseCompleted,
    ArkResponseStarted,
    ArkResponsesClient,
    ArkResponsesError,
    ArkTextDelta,
    ArkToolCall,
)
from nova_audio_agent.realtime.volcengine.asr import (
    AsrTranscript,
    DoubaoAsrClient,
    DoubaoAsrError,
    DoubaoAsrProtocol,
    asr_headers,
)
from nova_audio_agent.realtime.volcengine.tts import DoubaoTtsClient, TtsAudio
from nova_audio_agent.realtime.volcengine.protocol import (
    EventType,
    MessageType,
    VolcMessage,
)


def test_asr_headers_use_api_key_auth_without_putting_secret_in_connect_id() -> None:
    headers = asr_headers(api_key="asr-secret", resource_id="volc.seedasr.sauc.duration")

    assert headers["X-Api-Key"] == "asr-secret"
    assert headers["X-Api-Resource-Id"] == "volc.seedasr.sauc.duration"
    assert headers["X-Api-Connect-Id"] != "asr-secret"


def test_asr_protocol_encodes_gzipped_full_request_and_negative_final_audio() -> None:
    protocol = DoubaoAsrProtocol()
    request = protocol.full_request(sequence=1, sample_rate=16_000)
    final = protocol.audio(sequence=2, pcm=b"\x01\x02", final=True)

    assert request[:4] == bytes((0x11, 0x11, 0x11, 0x00))
    assert struct.unpack(">i", request[4:8])[0] == 1
    payload_size = struct.unpack(">I", request[8:12])[0]
    payload = json.loads(gzip.decompress(request[12 : 12 + payload_size]))
    assert payload["request"]["model_name"] == "bigmodel"
    assert payload["audio"]["rate"] == 16_000
    assert final[:4] == bytes((0x11, 0x23, 0x11, 0x00))
    assert struct.unpack(">i", final[4:8])[0] == -2


def test_asr_protocol_decodes_partial_and_final_transcripts() -> None:
    protocol = DoubaoAsrProtocol()
    partial_payload = gzip.compress(
        json.dumps({"result": {"text": "你好"}}, ensure_ascii=False).encode()
    )
    final_payload = gzip.compress(
        json.dumps({"result": {"text": "你好，Nova"}}, ensure_ascii=False).encode()
    )
    partial_frame = (
        bytes((0x11, 0x91, 0x11, 0x00))
        + struct.pack(">iI", 1, len(partial_payload))
        + partial_payload
    )
    final_frame = (
        bytes((0x11, 0x93, 0x11, 0x00)) + struct.pack(">iI", 2, len(final_payload)) + final_payload
    )

    assert protocol.decode(partial_frame) == AsrTranscript("你好", final=False)
    assert protocol.decode(final_frame) == AsrTranscript("你好，Nova", final=True)


def test_asr_protocol_handles_list_results_and_sanitizes_nested_errors() -> None:
    protocol = DoubaoAsrProtocol()
    result = gzip.compress(
        json.dumps({"payload_msg": {"result": [{"text": "你"}, {"text": "好"}]}}).encode()
    )
    error = gzip.compress(
        json.dumps({"payload_msg": {"code": 400, "message": "credential-must-not-leak"}}).encode()
    )
    result_frame = bytes((0x11, 0x91, 0x11, 0x00)) + struct.pack(">iI", 1, len(result)) + result
    error_frame = bytes((0x11, 0x91, 0x11, 0x00)) + struct.pack(">iI", 1, len(error)) + error

    assert protocol.decode(result_frame) == AsrTranscript("你好", final=False)
    with pytest.raises(DoubaoAsrError) as failure:
        protocol.decode(error_frame)
    assert "credential-must-not-leak" not in str(failure.value)


class _AsyncEvents:
    def __init__(self, events: list[Any]) -> None:
        self._events = iter(events)

    def __aiter__(self) -> _AsyncEvents:
        return self

    async def __anext__(self) -> Any:
        try:
            return next(self._events)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class _Responses:
    def __init__(self, events: list[Any]) -> None:
        self.events = events
        self.kwargs: dict[str, Any] | None = None

    async def create(self, **kwargs: Any) -> _AsyncEvents:
        self.kwargs = kwargs
        return _AsyncEvents(self.events)


@pytest.mark.asyncio
async def test_ark_client_disables_thinking_and_normalizes_text_stream() -> None:
    responses = _Responses(
        [
            SimpleNamespace(type="response.created", response=SimpleNamespace(id="resp-1")),
            SimpleNamespace(type="response.output_text.delta", delta="你好"),
            SimpleNamespace(type="response.completed", response=SimpleNamespace(id="resp-1")),
        ]
    )
    client = ArkResponsesClient(
        client=SimpleNamespace(responses=responses),
        model="doubao-seed-2-0-pro-260215",
        instructions="system",
    )

    events = [
        event
        async for event in client.stream(
            input_items=[{"role": "user", "content": "你好"}],
            tools=(),
            previous_response_id=None,
        )
    ]

    assert events == [
        ArkResponseStarted("resp-1"),
        ArkTextDelta("你好"),
        ArkResponseCompleted("resp-1"),
    ]
    assert responses.kwargs == {
        "model": "doubao-seed-2-0-pro-260215",
        "instructions": "system",
        "input": [{"role": "user", "content": "你好"}],
        "tools": [],
        "parallel_tool_calls": False,
        "store": True,
        "stream": True,
        "extra_body": {"thinking": {"type": "disabled"}},
    }


@pytest.mark.asyncio
async def test_ark_client_normalizes_completed_function_call() -> None:
    responses = _Responses(
        [
            SimpleNamespace(type="response.created", response=SimpleNamespace(id="resp-2")),
            SimpleNamespace(
                type="response.output_item.done",
                item=SimpleNamespace(
                    type="function_call",
                    id="item-1",
                    call_id="call-1",
                    name="weather__get",
                    arguments='{"city":"上海"}',
                ),
            ),
            SimpleNamespace(type="response.completed", response=SimpleNamespace(id="resp-2")),
        ]
    )
    client = ArkResponsesClient(
        client=SimpleNamespace(responses=responses),
        model="model",
        instructions="system",
    )

    events = [
        event
        async for event in client.stream(
            input_items=[{"role": "user", "content": "天气"}],
            tools=(),
            previous_response_id="resp-1",
        )
    ]

    assert events[1] == ArkToolCall(
        item_id="item-1",
        call_id="call-1",
        name="weather__get",
        arguments={"city": "上海"},
    )
    assert responses.kwargs is not None
    assert responses.kwargs["previous_response_id"] == "resp-1"


@pytest.mark.asyncio
async def test_ark_client_rejects_invalid_tool_arguments_without_exposing_them() -> None:
    responses = _Responses(
        [
            SimpleNamespace(type="response.created", response=SimpleNamespace(id="resp-bad")),
            SimpleNamespace(
                type="response.output_item.done",
                item=SimpleNamespace(
                    type="function_call",
                    id="item-bad",
                    call_id="call-bad",
                    name="weather__get",
                    arguments='{"credential":"must-not-leak"',
                ),
            ),
        ]
    )
    client = ArkResponsesClient(
        client=SimpleNamespace(responses=responses), model="model", instructions="system"
    )

    with pytest.raises(ArkResponsesError) as failure:
        _ = [
            event
            async for event in client.stream(input_items=[], tools=(), previous_response_id=None)
        ]

    assert "must-not-leak" not in str(failure.value)


@pytest.mark.asyncio
async def test_ark_client_close_releases_underlying_http_client() -> None:
    class Client:
        def __init__(self) -> None:
            self.closed = False

        async def close(self) -> None:
            self.closed = True

    raw_client = Client()
    client = ArkResponsesClient(client=raw_client, model="model", instructions="system")

    await client.close()

    assert raw_client.closed is True


def test_volc_message_round_trips_tts_session_and_audio_events() -> None:
    start = VolcMessage(
        message_type=MessageType.FULL_CLIENT_REQUEST,
        event=EventType.START_SESSION,
        session_id="session-1",
        payload=b"{}",
    ).marshal()
    audio = VolcMessage(
        message_type=MessageType.AUDIO_ONLY_SERVER,
        event=EventType.TTS_RESPONSE,
        session_id="session-1",
        payload=b"\x01\x02",
    ).marshal()

    assert VolcMessage.unmarshal(start).event == EventType.START_SESSION
    assert VolcMessage.unmarshal(start).session_id == "session-1"
    assert VolcMessage.unmarshal(audio).payload == b"\x01\x02"


def test_volc_message_decodes_connection_id_before_the_payload() -> None:
    connect_id = b"provider-connect-id"
    payload = b"{}"
    raw = (
        bytes((0x11, 0x94, 0x10, 0x00))
        + struct.pack(">iI", int(EventType.CONNECTION_STARTED), len(connect_id))
        + connect_id
        + struct.pack(">I", len(payload))
        + payload
    )

    message = VolcMessage.unmarshal(raw)

    assert message.event == EventType.CONNECTION_STARTED
    assert message.connect_id == "provider-connect-id"
    assert message.payload == payload


def test_volc_message_decodes_audio_only_frame_without_an_event_flag() -> None:
    payload = b"\x01\x02\x03\x04"
    raw = bytes((0x11, 0xB0, 0x00, 0x00)) + struct.pack(">I", len(payload)) + payload

    message = VolcMessage.unmarshal(raw)

    assert message.message_type == MessageType.AUDIO_ONLY_SERVER
    assert message.event is None
    assert message.payload == payload


class _Socket:
    def __init__(self, incoming: list[bytes]) -> None:
        self.incoming = iter(incoming)
        self.sent: list[bytes] = []
        self.closed = False

    async def send(self, payload: bytes) -> None:
        self.sent.append(payload)

    async def recv(self) -> bytes:
        return next(self.incoming)

    async def close(self) -> None:
        self.closed = True


class _Connector:
    def __init__(self, socket: _Socket) -> None:
        self.socket = socket
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def __call__(self, url: str, **kwargs: Any) -> _Socket:
        self.calls.append((url, kwargs))
        return self.socket


class _HangingSocket(_Socket):
    def __init__(self) -> None:
        super().__init__([])

    async def recv(self) -> bytes:
        await asyncio.Event().wait()
        raise AssertionError("unreachable")


def _asr_response(sequence: int, body: dict[str, Any]) -> bytes:
    payload = gzip.compress(json.dumps(body, ensure_ascii=False).encode())
    flag = 0x93 if sequence < 0 else 0x91
    return bytes((0x11, flag, 0x11, 0x00)) + struct.pack(">iI", sequence, len(payload)) + payload


@pytest.mark.asyncio
async def test_asr_session_holds_one_chunk_so_finish_marks_the_last_audio_frame() -> None:
    socket = _Socket(
        [
            _asr_response(0, {}),
            _asr_response(1, {"result": {"text": "你好"}}),
            _asr_response(-2, {"result": {"text": "你好 Nova"}, "is_last_package": True}),
        ]
    )
    client = DoubaoAsrClient(
        endpoint="wss://speech.example/asr",
        api_key="secret",
        resource_id="resource",
        sample_rate=1_000,
        chunk_ms=1,
        connector=_Connector(socket),
    )
    session = await client.open()

    await session.append(b"\x01\x02")
    await session.append(b"\x03\x04")
    await session.finish()
    events = [event async for event in session.events()]
    await session.close()

    assert events == [AsrTranscript("你好", False), AsrTranscript("你好 Nova", True)]
    assert socket.sent[1][1] & 0x0F == 0x01
    assert socket.sent[2][1] & 0x0F == 0x03


@pytest.mark.asyncio
async def test_asr_handshake_timeout_is_bounded_and_sanitized() -> None:
    socket = _HangingSocket()
    client = DoubaoAsrClient(
        endpoint="wss://speech.example/asr",
        api_key="credential-must-not-leak",
        resource_id="resource",
        receive_timeout=0.001,
        connector=_Connector(socket),
    )

    with pytest.raises(DoubaoAsrError) as failure:
        await client.open()

    assert socket.closed is True
    assert "credential-must-not-leak" not in str(failure.value)


@pytest.mark.asyncio
async def test_asr_session_packets_audio_in_configured_200_ms_windows() -> None:
    socket = _Socket([_asr_response(0, {})])
    client = DoubaoAsrClient(
        endpoint="wss://speech.example/asr",
        api_key="secret",
        resource_id="resource",
        sample_rate=16_000,
        chunk_ms=200,
        connector=_Connector(socket),
    )
    session = await client.open()

    await session.append(b"\x01\x02" * 4_160)  # 260 ms
    await session.append(b"\x03\x04" * 2_560)  # another 160 ms
    await session.finish()

    audio_frames = socket.sent[1:]
    decoded_sizes = []
    for frame in audio_frames:
        size = struct.unpack(">I", frame[8:12])[0]
        decoded_sizes.append(len(gzip.decompress(frame[12 : 12 + size])))
    assert decoded_sizes == [6_400, 6_400, 640]
    assert [frame[1] & 0x0F for frame in audio_frames] == [0x01, 0x01, 0x03]


@pytest.mark.asyncio
async def test_tts_session_streams_task_text_and_audio_until_session_finished() -> None:
    session_id = "tts-session"
    socket = _Socket(
        [
            VolcMessage(MessageType.FULL_SERVER_RESPONSE, EventType.CONNECTION_STARTED).marshal(),
            VolcMessage(
                MessageType.FULL_SERVER_RESPONSE,
                EventType.SESSION_STARTED,
                session_id=session_id,
            ).marshal(),
            VolcMessage(
                MessageType.AUDIO_ONLY_SERVER,
                EventType.TTS_RESPONSE,
                session_id=session_id,
                payload=b"\x01\x02",
            ).marshal(),
            VolcMessage(
                MessageType.FULL_SERVER_RESPONSE,
                EventType.SESSION_FINISHED,
                session_id=session_id,
            ).marshal(),
        ]
    )
    client = DoubaoTtsClient(
        endpoint="wss://speech.example/tts",
        api_key="secret",
        resource_id="seed-tts-2.0",
        voice="voice",
        connector=_Connector(socket),
        id_factory=lambda: session_id,
    )
    session = await client.open()

    await session.send_text("你好，")
    await session.finish()
    events = [event async for event in session.events()]
    await session.close()

    task = VolcMessage.unmarshal(socket.sent[2])
    start = VolcMessage.unmarshal(socket.sent[1])
    finish = VolcMessage.unmarshal(socket.sent[3])
    assert task.event == EventType.TASK_REQUEST
    assert json.loads(start.payload)["event"] == EventType.START_SESSION
    assert json.loads(task.payload)["event"] == EventType.TASK_REQUEST
    assert json.loads(task.payload)["req_params"]["text"] == "你好，"
    assert finish.event == EventType.FINISH_SESSION
    assert finish.payload == b"{}"
    assert VolcMessage.unmarshal(socket.sent[-1]).event == EventType.FINISH_CONNECTION
    assert socket.closed is True
    assert events == [TtsAudio(b"\x01\x02")]
