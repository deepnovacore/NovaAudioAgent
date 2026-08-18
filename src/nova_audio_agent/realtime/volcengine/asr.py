"""Doubao Seed ASR v3 binary protocol and streaming session."""

from __future__ import annotations

import asyncio
import gzip
import json
import struct
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from websockets.asyncio.client import connect as websocket_connect


class DoubaoAsrError(RuntimeError):
    """Sanitized ASR protocol failure."""


DEFAULT_CONNECT_TIMEOUT = 20.0
DEFAULT_RECEIVE_TIMEOUT = 15.0


@dataclass(frozen=True, slots=True)
class AsrTranscript:
    text: str
    final: bool


def asr_headers(*, api_key: str, resource_id: str) -> dict[str, str]:
    if not api_key or not resource_id:
        raise ValueError("ASR credentials and resource id are required")
    return {
        "X-Api-Key": api_key,
        "X-Api-Resource-Id": resource_id,
        "X-Api-Connect-Id": str(uuid4()),
    }


class DoubaoAsrProtocol:
    def full_request(self, *, sequence: int, sample_rate: int) -> bytes:
        payload = {
            "user": {"uid": str(uuid4())},
            "audio": {
                "format": "pcm",
                "rate": sample_rate,
                "bits": 16,
                "channel": 1,
                "codec": "raw",
            },
            "request": {
                "model_name": "bigmodel",
                "enable_punc": True,
                "enable_itn": True,
                "show_utterances": True,
                "result_type": "full",
            },
        }
        encoded = gzip.compress(json.dumps(payload, ensure_ascii=False).encode())
        return (
            bytes((0x11, 0x11, 0x11, 0x00)) + struct.pack(">iI", sequence, len(encoded)) + encoded
        )

    def audio(self, *, sequence: int, pcm: bytes, final: bool) -> bytes:
        if not pcm or len(pcm) % 2:
            raise ValueError("ASR audio must be aligned PCM16")
        encoded = gzip.compress(pcm)
        flags = 0x03 if final else 0x01
        wire_sequence = -sequence if final else sequence
        return (
            bytes((0x11, 0x20 | flags, 0x11, 0x00))
            + struct.pack(">iI", wire_sequence, len(encoded))
            + encoded
        )

    def decode(self, frame: bytes) -> AsrTranscript | None:
        if len(frame) < 12 or frame[0] != 0x11:
            raise DoubaoAsrError("豆包 ASR 返回了无效协议帧")
        message_type = frame[1] >> 4
        flags = frame[1] & 0x0F
        compression = frame[2] & 0x0F
        if message_type == 0x0F:
            raise DoubaoAsrError("豆包 ASR 请求失败")
        if message_type != 0x09 or flags not in {0x01, 0x03}:
            return None
        sequence, size = struct.unpack(">iI", frame[4:12])
        payload = frame[12 : 12 + size]
        if len(payload) != size:
            raise DoubaoAsrError("豆包 ASR 返回了截断协议帧")
        if compression == 0x01:
            try:
                payload = gzip.decompress(payload)
            except OSError as exc:
                raise DoubaoAsrError("豆包 ASR 返回了无效压缩数据") from exc
        try:
            body = json.loads(payload)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DoubaoAsrError("豆包 ASR 返回了无效 JSON") from exc
        if type(body) is not dict:
            raise DoubaoAsrError("豆包 ASR 返回了无效结果")
        _raise_provider_error(body)
        nested = _nested_body(body)
        if nested is not body:
            _raise_provider_error(nested)
        text = _extract_text(body)
        final = flags == 0x03 or sequence < 0 or body.get("is_last_package") is True
        return AsrTranscript(text, final=final) if text or final else None


class DoubaoAsrSession:
    def __init__(
        self,
        *,
        websocket: Any,
        protocol: DoubaoAsrProtocol,
        sequence: int,
        chunk_bytes: int,
        receive_timeout: float,
    ) -> None:
        self._websocket = websocket
        self._protocol = protocol
        self._sequence = sequence
        self._chunk_bytes = chunk_bytes
        self._receive_timeout = receive_timeout
        self._pending_audio = bytearray()
        self._finished = False

    async def append(self, pcm: bytes) -> None:
        if self._finished:
            raise DoubaoAsrError("豆包 ASR 会话已经结束")
        if not pcm or len(pcm) % 2:
            raise ValueError("ASR audio must be aligned PCM16")
        self._pending_audio.extend(pcm)
        while len(self._pending_audio) > self._chunk_bytes:
            chunk = bytes(self._pending_audio[: self._chunk_bytes])
            del self._pending_audio[: self._chunk_bytes]
            await self._websocket.send(
                self._protocol.audio(
                    sequence=self._sequence,
                    pcm=chunk,
                    final=False,
                )
            )
            self._sequence += 1

    async def finish(self) -> None:
        if self._finished:
            return
        if not self._pending_audio:
            raise DoubaoAsrError("豆包 ASR 会话没有音频")
        await self._websocket.send(
            self._protocol.audio(
                sequence=self._sequence,
                pcm=bytes(self._pending_audio),
                final=True,
            )
        )
        self._pending_audio.clear()
        self._finished = True

    async def events(self) -> AsyncIterator[AsrTranscript]:
        while True:
            try:
                raw = await asyncio.wait_for(self._websocket.recv(), timeout=self._receive_timeout)
            except Exception as exc:
                raise DoubaoAsrError(f"豆包 ASR 接收失败（{type(exc).__name__}）") from exc
            if type(raw) is not bytes:
                raise DoubaoAsrError("豆包 ASR 返回了无效帧类型")
            event = self._protocol.decode(raw)
            if event is None:
                continue
            yield event
            if event.final:
                return

    async def close(self) -> None:
        try:
            await self._websocket.close()
        except Exception as exc:
            raise DoubaoAsrError(f"豆包 ASR 关闭失败（{type(exc).__name__}）") from exc


class DoubaoAsrClient:
    def __init__(
        self,
        *,
        endpoint: str,
        api_key: str,
        resource_id: str,
        sample_rate: int = 16_000,
        chunk_ms: int = 200,
        connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
        receive_timeout: float = DEFAULT_RECEIVE_TIMEOUT,
        connector: Callable[..., Any] = websocket_connect,
    ) -> None:
        if type(sample_rate) is not int or sample_rate <= 0:
            raise ValueError("ASR sample rate must be a positive integer")
        if type(chunk_ms) is not int or chunk_ms <= 0:
            raise ValueError("ASR chunk duration must be a positive integer")
        if connect_timeout <= 0 or receive_timeout <= 0:
            raise ValueError("ASR timeouts must be positive")
        self._endpoint = endpoint
        self._api_key = api_key
        self._resource_id = resource_id
        self._sample_rate = sample_rate
        self._chunk_bytes = sample_rate * chunk_ms // 1000 * 2
        if self._chunk_bytes < 2:
            raise ValueError("ASR chunk duration is too small")
        self._connector = connector
        self._connect_timeout = float(connect_timeout)
        self._receive_timeout = float(receive_timeout)
        self._protocol = DoubaoAsrProtocol()

    async def open(self) -> DoubaoAsrSession:
        websocket: Any | None = None
        try:
            websocket = await self._connector(
                self._endpoint,
                additional_headers=asr_headers(
                    api_key=self._api_key,
                    resource_id=self._resource_id,
                ),
                open_timeout=self._connect_timeout,
                close_timeout=1,
                max_size=10 * 1024 * 1024,
            )
            await websocket.send(
                self._protocol.full_request(sequence=1, sample_rate=self._sample_rate)
            )
            acknowledgement = await asyncio.wait_for(
                websocket.recv(), timeout=self._receive_timeout
            )
            if type(acknowledgement) is not bytes:
                raise DoubaoAsrError("豆包 ASR 握手返回了无效帧")
            self._protocol.decode(acknowledgement)
            return DoubaoAsrSession(
                websocket=websocket,
                protocol=self._protocol,
                sequence=2,
                chunk_bytes=self._chunk_bytes,
                receive_timeout=self._receive_timeout,
            )
        except DoubaoAsrError:
            if websocket is not None:
                await websocket.close()
            raise
        except Exception as exc:
            if websocket is not None:
                await websocket.close()
            raise DoubaoAsrError(f"豆包 ASR 建连失败（{type(exc).__name__}）") from exc


def _raise_provider_error(body: dict[str, Any]) -> None:
    code = body.get("code")
    if code not in (None, 0, "0", 20_000_000, "20000000"):
        raise DoubaoAsrError("豆包 ASR 请求失败")


def _extract_text(body: dict[str, Any]) -> str:
    body = _nested_body(body)
    result = body.get("result")
    if type(result) is list:
        return "".join(item.get("text", "") for item in result if type(item) is dict).strip()
    if type(result) is dict:
        text = result.get("text")
        if type(text) is str:
            return text.strip()
        utterances = result.get("utterances")
        if type(utterances) is list:
            return "".join(
                item.get("text", "") for item in utterances if type(item) is dict
            ).strip()
    text = body.get("text")
    return text.strip() if type(text) is str else ""


def _nested_body(body: dict[str, Any]) -> dict[str, Any]:
    nested = body.get("payload_msg")
    if type(nested) is str:
        try:
            nested = json.loads(nested)
        except json.JSONDecodeError:
            nested = None
    if type(nested) is dict:
        return nested
    return body
