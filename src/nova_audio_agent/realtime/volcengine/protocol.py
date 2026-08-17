"""Shared binary framing for Doubao bidirectional speech services."""

from __future__ import annotations

import struct
from dataclasses import dataclass
from enum import IntEnum


class MessageType(IntEnum):
    FULL_CLIENT_REQUEST = 0x01
    FULL_SERVER_RESPONSE = 0x09
    AUDIO_ONLY_SERVER = 0x0B
    ERROR = 0x0F


class EventType(IntEnum):
    START_CONNECTION = 1
    FINISH_CONNECTION = 2
    CONNECTION_STARTED = 50
    CONNECTION_FAILED = 51
    CONNECTION_FINISHED = 52
    START_SESSION = 100
    CANCEL_SESSION = 101
    FINISH_SESSION = 102
    SESSION_STARTED = 150
    SESSION_CANCELED = 151
    SESSION_FINISHED = 152
    SESSION_FAILED = 153
    TASK_REQUEST = 200
    TTS_SENTENCE_START = 350
    TTS_SENTENCE_END = 351
    TTS_RESPONSE = 352
    TTS_ENDED = 359


_SESSION_EVENTS = {
    EventType.START_SESSION,
    EventType.CANCEL_SESSION,
    EventType.FINISH_SESSION,
    EventType.SESSION_STARTED,
    EventType.SESSION_CANCELED,
    EventType.SESSION_FINISHED,
    EventType.SESSION_FAILED,
    EventType.TASK_REQUEST,
    EventType.TTS_SENTENCE_START,
    EventType.TTS_SENTENCE_END,
    EventType.TTS_RESPONSE,
    EventType.TTS_ENDED,
}
_CONNECTION_RESPONSE_EVENTS = {
    EventType.CONNECTION_STARTED,
    EventType.CONNECTION_FAILED,
    EventType.CONNECTION_FINISHED,
}


class VolcProtocolError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class VolcMessage:
    message_type: MessageType
    event: EventType | None
    payload: bytes = b""
    session_id: str | None = None
    connect_id: str | None = None
    sequence: int | None = None
    error_code: int | None = None

    def marshal(self) -> bytes:
        if self.event is None:
            raise ValueError("client message requires event")
        body = bytearray(struct.pack(">i", int(self.event)))
        if self.event in _SESSION_EVENTS:
            if not self.session_id:
                raise ValueError("session event requires session_id")
            encoded_session = self.session_id.encode()
            body.extend(struct.pack(">I", len(encoded_session)))
            body.extend(encoded_session)
        elif (
            self.event in _CONNECTION_RESPONSE_EVENTS
            and self.message_type != MessageType.FULL_CLIENT_REQUEST
        ):
            encoded_connect = (self.connect_id or "").encode()
            body.extend(struct.pack(">I", len(encoded_connect)))
            body.extend(encoded_connect)
        body.extend(struct.pack(">I", len(self.payload)))
        body.extend(self.payload)
        serialization = 0x10 if self.message_type == MessageType.FULL_CLIENT_REQUEST else 0x00
        return bytes((0x11, (int(self.message_type) << 4) | 0x04, serialization, 0x00)) + body

    @classmethod
    def unmarshal(cls, raw: bytes) -> VolcMessage:
        if len(raw) < 8 or raw[0] >> 4 != 0x01:
            raise VolcProtocolError("豆包语音返回了无效协议帧")
        header_size = (raw[0] & 0x0F) * 4
        flag = raw[1] & 0x0F
        if header_size < 4 or header_size > len(raw) or flag not in {0, 1, 2, 3, 4}:
            raise VolcProtocolError("豆包语音返回了无效协议帧")
        try:
            message_type = MessageType(raw[1] >> 4)
        except ValueError as exc:
            raise VolcProtocolError("豆包语音返回了未知消息类型") from exc
        offset = header_size
        sequence: int | None = None
        error_code: int | None = None
        if message_type == MessageType.ERROR:
            offset, error_code = _take_int(raw, offset, signed=False)
        elif flag in {1, 3}:
            offset, sequence = _take_int(raw, offset, signed=True)
        event: EventType | None = None
        session_id: str | None = None
        connect_id: str | None = None
        if flag == 4:
            try:
                offset, raw_event = _take_int(raw, offset, signed=True)
                event = EventType(raw_event)
            except (ValueError, struct.error) as exc:
                raise VolcProtocolError("豆包语音返回了未知协议事件") from exc
            if event in _SESSION_EVENTS:
                offset, encoded_session = _take_sized(raw, offset)
                try:
                    session_id = encoded_session.decode()
                except UnicodeDecodeError as exc:
                    raise VolcProtocolError("豆包语音返回了无效会话标识") from exc
            elif event in _CONNECTION_RESPONSE_EVENTS:
                offset, encoded_connect = _take_sized(raw, offset)
                try:
                    connect_id = encoded_connect.decode()
                except UnicodeDecodeError as exc:
                    raise VolcProtocolError("豆包语音返回了无效连接标识") from exc
        offset, payload = _take_sized(raw, offset)
        if offset != len(raw):
            raise VolcProtocolError("豆包语音返回了尾随协议数据")
        return cls(
            message_type=message_type,
            event=event,
            payload=payload,
            session_id=session_id,
            connect_id=connect_id,
            sequence=sequence,
            error_code=error_code,
        )


def _take_sized(raw: bytes, offset: int) -> tuple[int, bytes]:
    if offset + 4 > len(raw):
        raise VolcProtocolError("豆包语音返回了截断协议帧")
    size = struct.unpack(">I", raw[offset : offset + 4])[0]
    offset += 4
    end = offset + size
    if end > len(raw):
        raise VolcProtocolError("豆包语音返回了截断协议帧")
    return end, raw[offset:end]


def _take_int(raw: bytes, offset: int, *, signed: bool) -> tuple[int, int]:
    end = offset + 4
    if end > len(raw):
        raise VolcProtocolError("豆包语音返回了截断协议帧")
    return end, int.from_bytes(raw[offset:end], "big", signed=signed)
