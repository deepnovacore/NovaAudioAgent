"""Streaming text preparation for Doubao bidirectional TTS."""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from websockets.asyncio.client import connect as websocket_connect

from nova_audio_agent.realtime.volcengine.protocol import EventType, MessageType, VolcMessage

_BOUNDARY = re.compile(r"[，。！？；：,.!?;:]|\n")
DEFAULT_CONNECT_TIMEOUT = 20.0
DEFAULT_RECEIVE_TIMEOUT = 15.0


class TextChunker:
    def __init__(self, *, soft_limit: int = 18, hard_limit: int = 48) -> None:
        if soft_limit < 1 or hard_limit < soft_limit:
            raise ValueError("invalid TTS text limits")
        self._soft_limit = soft_limit
        self._hard_limit = hard_limit
        self._pending = ""
        self._first = True

    def push(self, text: str) -> tuple[str, ...]:
        if type(text) is not str:
            raise TypeError("TTS text delta must be a string")
        self._pending += text
        chunks: list[str] = []
        while self._pending:
            boundary = self._flush_boundary()
            if boundary is None and len(self._pending) < self._hard_limit:
                break
            end = self._hard_limit if boundary is None else min(boundary, self._hard_limit)
            chunks.append(self._pending[:end])
            self._pending = self._pending[end:]
            self._first = False
        return tuple(chunks)

    def finish(self) -> tuple[str, ...]:
        if not self._pending:
            return ()
        pending, self._pending = self._pending, ""
        self._first = False
        return (pending,)

    def _flush_boundary(self) -> int | None:
        for match in _BOUNDARY.finditer(self._pending):
            end = match.end()
            if self._first or end >= self._soft_limit:
                return end
        return None


class DoubaoTtsError(RuntimeError):
    """Sanitized bidirectional TTS failure."""


@dataclass(frozen=True, slots=True)
class TtsAudio:
    pcm: bytes


def tts_headers(*, api_key: str, resource_id: str) -> dict[str, str]:
    if not api_key or not resource_id:
        raise ValueError("TTS credentials and resource id are required")
    return {
        "X-Api-Key": api_key,
        "X-Api-Resource-Id": resource_id,
        "X-Api-Connect-Id": str(uuid4()),
    }


class DoubaoTtsSession:
    def __init__(
        self,
        *,
        websocket: Any,
        session_id: str,
        voice: str,
        sample_rate: int,
        receive_timeout: float,
    ) -> None:
        self._websocket = websocket
        self._session_id = session_id
        self._voice = voice
        self._sample_rate = sample_rate
        self._receive_timeout = receive_timeout
        self._finished = False

    async def send_text(self, text: str) -> None:
        if self._finished:
            raise DoubaoTtsError("豆包 TTS 会话已经结束")
        if type(text) is not str or not text:
            raise ValueError("TTS text must be non-empty")
        payload = _tts_payload(
            self._voice,
            self._sample_rate,
            event=EventType.TASK_REQUEST,
            text=text,
        )
        await self._websocket.send(
            VolcMessage(
                MessageType.FULL_CLIENT_REQUEST,
                EventType.TASK_REQUEST,
                json.dumps(payload, ensure_ascii=False).encode(),
                self._session_id,
            ).marshal()
        )

    async def finish(self) -> None:
        if self._finished:
            return
        self._finished = True
        await self._websocket.send(
            VolcMessage(
                MessageType.FULL_CLIENT_REQUEST,
                EventType.FINISH_SESSION,
                b"{}",
                session_id=self._session_id,
            ).marshal()
        )

    async def cancel(self) -> None:
        if self._finished:
            return
        self._finished = True
        await self._websocket.send(
            VolcMessage(
                MessageType.FULL_CLIENT_REQUEST,
                EventType.CANCEL_SESSION,
                b"{}",
                session_id=self._session_id,
            ).marshal()
        )

    async def events(self) -> AsyncIterator[TtsAudio]:
        while True:
            try:
                raw = await asyncio.wait_for(self._websocket.recv(), timeout=self._receive_timeout)
            except Exception as exc:
                raise DoubaoTtsError(f"豆包 TTS 接收失败（{type(exc).__name__}）") from exc
            if type(raw) is not bytes:
                raise DoubaoTtsError("豆包 TTS 返回了无效帧类型")
            message = VolcMessage.unmarshal(raw)
            if message.session_id not in {None, self._session_id}:
                continue
            if message.message_type == MessageType.AUDIO_ONLY_SERVER and message.payload:
                yield TtsAudio(message.payload)
            elif message.event == EventType.SESSION_FINISHED:
                return
            elif message.message_type == MessageType.ERROR or message.event in {
                EventType.SESSION_FAILED,
                EventType.CONNECTION_FAILED,
            }:
                raise DoubaoTtsError("豆包 TTS 请求失败")

    async def close(self) -> None:
        try:
            try:
                await self._websocket.send(
                    VolcMessage(
                        MessageType.FULL_CLIENT_REQUEST,
                        EventType.FINISH_CONNECTION,
                        b"{}",
                    ).marshal()
                )
            finally:
                await self._websocket.close()
        except Exception as exc:
            raise DoubaoTtsError(f"豆包 TTS 关闭失败（{type(exc).__name__}）") from exc


class DoubaoTtsClient:
    def __init__(
        self,
        *,
        endpoint: str,
        api_key: str,
        resource_id: str,
        voice: str,
        output_sample_rate: int = 24_000,
        connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
        receive_timeout: float = DEFAULT_RECEIVE_TIMEOUT,
        connector: Callable[..., Any] = websocket_connect,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        if connect_timeout <= 0 or receive_timeout <= 0:
            raise ValueError("TTS timeouts must be positive")
        self._endpoint = endpoint
        self._api_key = api_key
        self._resource_id = resource_id
        self._voice = voice
        self._output_sample_rate = output_sample_rate
        self._connector = connector
        self._connect_timeout = float(connect_timeout)
        self._receive_timeout = float(receive_timeout)
        self._id_factory = (lambda: str(uuid4())) if id_factory is None else id_factory

    async def open(self) -> DoubaoTtsSession:
        websocket: Any | None = None
        try:
            websocket = await self._connector(
                self._endpoint,
                additional_headers=tts_headers(
                    api_key=self._api_key,
                    resource_id=self._resource_id,
                ),
                open_timeout=self._connect_timeout,
                close_timeout=1,
                max_size=10 * 1024 * 1024,
            )
            await websocket.send(
                VolcMessage(
                    MessageType.FULL_CLIENT_REQUEST,
                    EventType.START_CONNECTION,
                    b"{}",
                ).marshal()
            )
            await _expect_event(
                websocket,
                EventType.CONNECTION_STARTED,
                timeout=self._receive_timeout,
            )
            session_id = self._id_factory()
            await websocket.send(
                VolcMessage(
                    MessageType.FULL_CLIENT_REQUEST,
                    EventType.START_SESSION,
                    json.dumps(
                        _tts_payload(
                            self._voice,
                            self._output_sample_rate,
                            event=EventType.START_SESSION,
                        ),
                        ensure_ascii=False,
                    ).encode(),
                    session_id,
                ).marshal()
            )
            await _expect_event(
                websocket,
                EventType.SESSION_STARTED,
                session_id=session_id,
                timeout=self._receive_timeout,
            )
            return DoubaoTtsSession(
                websocket=websocket,
                session_id=session_id,
                voice=self._voice,
                sample_rate=self._output_sample_rate,
                receive_timeout=self._receive_timeout,
            )
        except BaseException as exc:
            if websocket is not None:
                try:
                    await websocket.close()
                except Exception:
                    pass
            if isinstance(exc, asyncio.CancelledError | DoubaoTtsError):
                raise
            if not isinstance(exc, Exception):
                raise
            raise DoubaoTtsError(f"豆包 TTS 建连失败（{type(exc).__name__}）") from exc


async def _expect_event(
    websocket: Any,
    event: EventType,
    *,
    session_id: str | None = None,
    timeout: float,
) -> None:
    raw = await asyncio.wait_for(websocket.recv(), timeout=timeout)
    if type(raw) is not bytes:
        raise DoubaoTtsError("豆包 TTS 握手返回了无效帧")
    message = VolcMessage.unmarshal(raw)
    if message.event != event or (session_id is not None and message.session_id != session_id):
        raise DoubaoTtsError("豆包 TTS 握手返回了意外事件")


def _tts_payload(
    voice: str,
    sample_rate: int,
    *,
    event: EventType,
    text: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "event": event,
        "user": {"uid": str(uuid4())},
        "namespace": "BidirectionalTTS",
        "req_params": {
            "speaker": voice,
            "audio_params": {
                "format": "pcm",
                "sample_rate": sample_rate,
                "enable_timestamp": False,
            },
            "additions": json.dumps({"disable_markdown_filter": False}),
        },
    }
    if text is not None:
        payload["req_params"]["text"] = text
    return payload
