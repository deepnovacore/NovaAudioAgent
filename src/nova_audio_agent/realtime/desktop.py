"""Bounded loopback framing for the Electron renderer.

This module translates desktop transport frames only. Runtime, Memory, Floor, and
provider policy remain owned by ``RealtimeService`` and ``RealtimeSession``.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import math
import os
import signal
import string
import struct
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from nova_audio_agent.events import AssistantSpoken
from nova_audio_agent.executors.codex_projects import PublicProjectView
from nova_audio_agent.realtime.memory_board import memory_board_message
from nova_audio_agent.realtime.playback import (
    MAX_PLAYBACK_FRAME_BYTES,
    PlaybackCompletion,
    PlaybackFrame,
)
from nova_audio_agent.realtime.project_confirmation import (
    PROJECT_CONFIRMATION_TTL_SECONDS,
)
from nova_audio_agent.realtime.service import CodexState
from nova_audio_agent.realtime.session import CaptionFrame
from nova_audio_agent.realtime.telemetry import RealtimeTelemetry

if TYPE_CHECKING:
    from nova_audio_agent.clock import Clock

if TYPE_CHECKING:
    from nova_audio_agent.realtime.service import RealtimeService

MAX_DESKTOP_JSON_BYTES = 16 * 1024
MAX_DESKTOP_PCM_BYTES = MAX_PLAYBACK_FRAME_BYTES
MAX_AUDIO_HEADER_BYTES = 2048
_AUDIO_MAGIC = b"NOVA"


class DesktopProtocolError(RuntimeError):
    """Bounded protocol failure that never embeds frame or credential contents."""


DesktopCommandKind = Literal[
    "authenticated",
    "speech_onset",
    "playback_started",
    "playback_stopped",
    "playback_done",
    "playback_cleared",
    "memory_board_request",
    "clock_pong",
]


@dataclass(frozen=True, slots=True)
class DesktopCommand:
    kind: DesktopCommandKind
    payload: dict[str, str | int | float]


def parse_client_message(
    raw: str,
    *,
    expected_token: str,
    authenticated: bool,
) -> DesktopCommand:
    if type(raw) is not str:
        raise DesktopProtocolError("desktop control frame must be text")
    if len(raw.encode("utf-8")) > MAX_DESKTOP_JSON_BYTES:
        raise DesktopProtocolError("desktop control frame is too large")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise DesktopProtocolError("desktop control frame is invalid JSON") from exc
    if type(value) is not dict or type(value.get("type")) is not str:
        raise DesktopProtocolError("desktop control frame has no type")
    if not authenticated:
        token = value.get("token")
        if (
            value["type"] != "hello"
            or type(token) is not str
            or not hmac.compare_digest(token, expected_token)
        ):
            raise DesktopProtocolError("desktop authentication failed")
        return DesktopCommand("authenticated", {})

    kind = value["type"]
    if kind == "speech.onset":
        payload: dict[str, str | int | float] = {"speech_id": _identifier(value, "speech_id")}
        _read_render_timestamp(value, payload)
        return DesktopCommand("speech_onset", payload)
    if kind in {"playback.started", "playback.stopped", "playback.done", "playback.cleared"}:
        utterance_id = _identifier(value, "utterance_id")
        generation_epoch = value.get("generation_epoch")
        if type(generation_epoch) is not int or generation_epoch < 1:
            raise DesktopProtocolError("desktop playback generation is invalid")
        payload = {
            "utterance_id": utterance_id,
            "generation_epoch": generation_epoch,
        }
        if kind != "playback.started":
            played_ms = value.get("played_ms")
            if played_ms is not None:
                if type(played_ms) is not int or played_ms < 0:
                    raise DesktopProtocolError("desktop playback played_ms is invalid")
                payload["played_ms"] = played_ms
        _read_render_timestamp(value, payload)
        command_kind = kind.replace(".", "_")
        return DesktopCommand(command_kind, payload)  # type: ignore[arg-type]
    if kind == "memory.board.request":
        return DesktopCommand(
            "memory_board_request",
            {"request_id": _identifier(value, "request_id")},
        )
    if kind == "clock.pong":
        payload = {"ping_id": _identifier(value, "ping_id")}
        timestamp = value.get("t_render_ms")
        if type(timestamp) not in {int, float} or timestamp < 0:
            raise DesktopProtocolError("desktop t_render_ms is invalid")
        payload["t_render_ms"] = float(timestamp)
        return DesktopCommand("clock_pong", payload)
    raise DesktopProtocolError("desktop control frame type is unsupported")


def _read_render_timestamp(value: dict[str, Any], payload: dict[str, str | int | float]) -> None:
    timestamp = value.get("t_render_ms")
    if timestamp is None:
        return
    if type(timestamp) not in {int, float} or timestamp < 0:
        raise DesktopProtocolError("desktop t_render_ms is invalid")
    payload["t_render_ms"] = float(timestamp)


def encode_audio_frame(frame: PlaybackFrame) -> bytes:
    _validate_playback_frame(frame)
    if len(frame.pcm) > MAX_DESKTOP_PCM_BYTES:
        raise DesktopProtocolError("desktop PCM frame is too large")
    header = json.dumps(
        {
            "utterance_id": frame.utterance_id,
            "generation_epoch": frame.generation_epoch,
            "sequence": frame.sequence,
        },
        ensure_ascii=True,
        separators=(",", ":"),
    ).encode("ascii")
    if len(header) > MAX_AUDIO_HEADER_BYTES:
        raise DesktopProtocolError("desktop audio header is too large")
    return _AUDIO_MAGIC + struct.pack(">H", len(header)) + header + frame.pcm


def decode_audio_frame(raw: bytes) -> PlaybackFrame:
    if type(raw) is not bytes or len(raw) < len(_AUDIO_MAGIC) + 2:
        raise DesktopProtocolError("desktop audio frame is invalid")
    if raw[:4] != _AUDIO_MAGIC:
        raise DesktopProtocolError("desktop audio frame has invalid magic")
    header_size = struct.unpack(">H", raw[4:6])[0]
    if header_size < 2 or header_size > MAX_AUDIO_HEADER_BYTES:
        raise DesktopProtocolError("desktop audio header is invalid")
    split = 6 + header_size
    if split > len(raw):
        raise DesktopProtocolError("desktop audio frame is truncated")
    try:
        header = json.loads(raw[6:split])
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DesktopProtocolError("desktop audio header is invalid") from exc
    pcm = raw[split:]
    frame = PlaybackFrame(
        utterance_id=_identifier(header, "utterance_id"),
        generation_epoch=_positive_integer(header, "generation_epoch"),
        sequence=_nonnegative_integer(header, "sequence"),
        pcm=pcm,
    )
    _validate_playback_frame(frame)
    if len(pcm) > MAX_DESKTOP_PCM_BYTES:
        raise DesktopProtocolError("desktop PCM frame is too large")
    return frame


def validate_input_pcm(raw: bytes) -> bytes:
    if type(raw) is not bytes or not raw or len(raw) % 2:
        raise DesktopProtocolError("desktop input must be aligned PCM16 bytes")
    if len(raw) > MAX_DESKTOP_PCM_BYTES:
        raise DesktopProtocolError("desktop input PCM frame is too large")
    return raw


def playback_clear_message(utterance_id: str, generation_epoch: int) -> str:
    payload = {
        "type": "playback.clear",
        "utterance_id": _plain_identifier(utterance_id),
        "generation_epoch": _plain_positive_integer(generation_epoch),
    }
    return json.dumps(payload, ensure_ascii=True, separators=(",", ":"))


def playback_alert_message(
    utterance_id: str | None,
    generation_epoch: int | None,
) -> str:
    if (utterance_id is None) != (generation_epoch is None):
        raise DesktopProtocolError("desktop alert identity must be complete")
    payload: dict[str, str | int] = {"type": "playback.alert"}
    if utterance_id is not None and generation_epoch is not None:
        payload["utterance_id"] = _plain_identifier(utterance_id)
        payload["generation_epoch"] = _plain_positive_integer(generation_epoch)
    return json.dumps(payload, ensure_ascii=True, separators=(",", ":"))


def playback_terminal_message(utterance_id: str, generation_epoch: int) -> str:
    payload = {
        "type": "playback.terminal",
        "utterance_id": _plain_identifier(utterance_id),
        "generation_epoch": _plain_positive_integer(generation_epoch),
    }
    return json.dumps(payload, ensure_ascii=True, separators=(",", ":"))


def codex_state_message(state: CodexState) -> str:
    if state not in {"idle", "running"}:
        raise DesktopProtocolError("desktop Codex state is invalid")
    return json.dumps(
        {"type": "codex.state", "state": state},
        ensure_ascii=True,
        separators=(",", ":"),
    )


def codex_project_message(view: PublicProjectView) -> str:
    if type(view) is not PublicProjectView:
        raise DesktopProtocolError("desktop Codex project view is invalid")
    for value in (
        view.workspace_display_name,
        view.session_title,
        view.pending_workspace_display_name,
        view.pending_session_title,
    ):
        if value is not None and (type(value) is not str or not value or len(value) > 120):
            raise DesktopProtocolError("desktop Codex project view is invalid")
    if type(view.pending_confirmation) is not bool:
        raise DesktopProtocolError("desktop Codex project view is invalid")
    pending_action = view.pending_action
    if pending_action is not None and (
        type(pending_action) is not str
        or pending_action
        not in {
            "create_workspace",
            "select_workspace",
            "resume_session",
        }
    ):
        raise DesktopProtocolError("desktop Codex project view is invalid")
    expires = view.pending_expires_in_seconds
    if expires is not None and (
        type(expires) not in {int, float}
        or not math.isfinite(expires)
        or expires < 0
        or expires > PROJECT_CONFIRMATION_TTL_SECONDS
    ):
        raise DesktopProtocolError("desktop Codex project view is invalid")
    has_pending_metadata = any(
        value is not None
        for value in (
            view.pending_action,
            view.pending_workspace_display_name,
            view.pending_session_title,
            expires,
        )
    )
    if not view.pending_confirmation and has_pending_metadata:
        raise DesktopProtocolError("desktop Codex project view is invalid")
    if (
        view.pending_confirmation
        and has_pending_metadata
        and (
            view.pending_action is None
            or view.pending_workspace_display_name is None
            or expires is None
        )
    ):
        raise DesktopProtocolError("desktop Codex project view is invalid")
    if pending_action == "resume_session" and view.pending_session_title is None:
        raise DesktopProtocolError("desktop Codex project view is invalid")
    return json.dumps(
        {
            "type": "codex.project",
            "workspace_display_name": view.workspace_display_name,
            "session_title": view.session_title,
            "pending_confirmation": view.pending_confirmation,
            "pending_action": view.pending_action,
            "pending_workspace_display_name": view.pending_workspace_display_name,
            "pending_session_title": view.pending_session_title,
            "pending_expires_in_seconds": expires,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def caption_message(frame: CaptionFrame, sequence: int) -> str:
    payload = {
        "type": "caption",
        "role": frame.role,
        "text": frame.text,
        "final": frame.final,
        "sequence": sequence,
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


class DesktopSocketBridge:
    """One-client transport adapter around an already-built RealtimeService."""

    def __init__(
        self,
        *,
        token: str,
        service: RealtimeService,
        stop: asyncio.Event,
        max_outbound_frames: int = 128,
        memory_board: Callable[[str], str] | None = None,
        clock: Clock | None = None,
        telemetry: RealtimeTelemetry | None = None,
        project_view: PublicProjectView | None = None,
    ) -> None:
        if len(token) != 32 or any(character not in string.hexdigits for character in token):
            raise ValueError("desktop token must be 128-bit hexadecimal")
        self._token = token
        self._service = service
        self._stop = stop
        self._outbound: asyncio.Queue[str | bytes] = asyncio.Queue(max_outbound_frames)
        self._preempt_outbound: asyncio.Queue[str] = asyncio.Queue(max_outbound_frames)
        self._codex_outbound: asyncio.Queue[CodexState] = asyncio.Queue(maxsize=1)
        self._project_outbound: asyncio.Queue[PublicProjectView] = asyncio.Queue(maxsize=1)
        self._fenced_generation_epoch = 0
        self._caption_sequence = 0
        self._latest_assistant_caption_sequence = 0
        self._fenced_assistant_caption_sequence = 0
        self._claimed = False
        self._authenticated = False
        self._codex_state: CodexState = getattr(service, "codex_state", "idle")
        self._last_codex_state_sent: CodexState | None = None
        self._project_view = project_view
        self._last_project_view_sent: PublicProjectView | None = None
        self._codex_send_task: asyncio.Task[Any] | None = None
        self._memory_board = memory_board
        self._clock = clock
        self._telemetry = telemetry if clock is not None else None
        self._uplink_frames = 0
        self._uplink_bytes = 0
        self._uplink_flushed_at = 0.0 if clock is None else clock.now()
        self._ping_sent: dict[str, float] = {}
        self._first_frame_seen: tuple[str, int] | None = None

    def on_audio_frame(self, frame: PlaybackFrame) -> None:
        sent = self._enqueue(encode_audio_frame(frame))
        if sent and self._telemetry is not None and frame.sequence == 0:
            key = (frame.utterance_id, frame.generation_epoch)
            if self._first_frame_seen != key:
                self._first_frame_seen = key
                self._telemetry.record(
                    "playback.first_frame_enqueued",
                    {
                        "utterance_id": frame.utterance_id,
                        "generation_epoch": frame.generation_epoch,
                    },
                )

    def on_audio_clear(self, utterance_id: str, generation_epoch: int) -> None:
        self._fenced_generation_epoch = max(self._fenced_generation_epoch, generation_epoch)
        self._fenced_assistant_caption_sequence = max(
            self._fenced_assistant_caption_sequence,
            self._latest_assistant_caption_sequence,
        )
        sent = self._enqueue_preempt(playback_clear_message(utterance_id, generation_epoch))
        if sent and self._telemetry is not None:
            self._telemetry.record(
                "playback.clear_sent",
                {"utterance_id": utterance_id, "generation_epoch": generation_epoch},
            )

    def on_audio_alert(
        self,
        utterance_id: str | None,
        generation_epoch: int | None,
    ) -> None:
        message = playback_alert_message(utterance_id, generation_epoch)
        if generation_epoch is not None:
            self._fenced_generation_epoch = max(
                self._fenced_generation_epoch,
                generation_epoch,
            )
        self._fenced_assistant_caption_sequence = max(
            self._fenced_assistant_caption_sequence,
            self._latest_assistant_caption_sequence,
        )
        sent = self._enqueue_preempt(message)
        if sent and self._telemetry is not None:
            self._telemetry.record(
                "renderer.alert_tone_sent",
                {"generation_qualified": generation_epoch is not None},
            )

    def on_audio_terminal(self, utterance_id: str, generation_epoch: int) -> None:
        self._enqueue(playback_terminal_message(utterance_id, generation_epoch))

    def on_codex_state(self, state: CodexState) -> None:
        codex_state_message(state)
        if state == self._codex_state:
            return
        self._codex_state = state
        self._cancel_codex_state_send()
        self._sync_codex_state_delivery()

    def on_codex_project(self, view: PublicProjectView) -> None:
        codex_project_message(view)
        if view == self._project_view:
            return
        self._project_view = view
        self._sync_project_delivery()

    def on_caption(self, frame: CaptionFrame) -> None:
        self._caption_sequence += 1
        if frame.role == "assistant":
            self._latest_assistant_caption_sequence = self._caption_sequence
        self._enqueue(caption_message(frame, self._caption_sequence), droppable=True)

    def claim(self) -> bool:
        if self._claimed:
            return False
        self._claimed = True
        return True

    def release(self) -> None:
        self._claimed = False
        self._authenticated = False
        self._last_codex_state_sent = None
        self._last_project_view_sent = None
        self._cancel_codex_state_send()
        self._clear_codex_outbound()
        self._clear_project_outbound()

    async def receive(self, raw: str | bytes, *, authenticated: bool) -> bool:
        if not authenticated:
            if type(raw) is not str:
                raise DesktopProtocolError("desktop authentication frame must be text")
            parse_client_message(raw, expected_token=self._token, authenticated=False)
            return True
        if type(raw) is bytes:
            self._record_uplink(len(raw))
            await self._service.send_audio(validate_input_pcm(raw))
            return True
        command = parse_client_message(raw, expected_token=self._token, authenticated=True)
        if self._telemetry is not None and command.kind != "memory_board_request":
            self._telemetry.record("renderer.ack", {"kind": command.kind, **command.payload})
        if command.kind == "clock_pong":
            self._record_sync_sample(
                str(command.payload["ping_id"]),
                float(command.payload["t_render_ms"]),
            )
            return True
        if command.kind == "speech_onset":
            await self._service.local_speech_onset(str(command.payload["speech_id"]))
        elif command.kind == "playback_started":
            self._service.playback_started(
                str(command.payload["utterance_id"]),
                int(command.payload["generation_epoch"]),
            )
        elif command.kind == "playback_done":
            self._service.playback_done(
                str(command.payload["utterance_id"]),
                int(command.payload["generation_epoch"]),
                _optional_played_ms(command.payload),
            )
        elif command.kind == "playback_stopped":
            await self._service.playback_stopped(
                str(command.payload["utterance_id"]),
                int(command.payload["generation_epoch"]),
                _optional_played_ms(command.payload),
            )
        elif command.kind == "playback_cleared":
            self._service.playback_cleared(
                str(command.payload["utterance_id"]),
                int(command.payload["generation_epoch"]),
                _optional_played_ms(command.payload),
            )
        elif command.kind == "memory_board_request":
            if self._memory_board is not None:
                self._enqueue(
                    self._memory_board(str(command.payload["request_id"])),
                    droppable=True,
                )
        return True

    async def handle(self, websocket: Any) -> None:
        if not self.claim():
            await websocket.close(code=4009, reason="desktop client already connected")
            return
        sender: asyncio.Task[None] | None = None
        try:
            first = await websocket.recv()
            await self.receive(first, authenticated=False)
            await websocket.send('{"type":"desktop.ready"}')
            initial_codex_state = self._codex_state
            self._authenticated = True
            await websocket.send(codex_state_message(initial_codex_state))
            self._last_codex_state_sent = initial_codex_state
            initial_project_view = self._project_view
            if initial_project_view is not None:
                await websocket.send(codex_project_message(initial_project_view))
                self._last_project_view_sent = initial_project_view
            self._sync_codex_state_delivery()
            self._sync_project_delivery()
            self.send_clock_pings()
            sender = asyncio.create_task(self._send_loop(websocket))
            async for raw in websocket:
                await self.receive(raw, authenticated=True)
        except DesktopProtocolError:
            await websocket.close(code=4003, reason="desktop protocol rejected")
        finally:
            if sender is not None:
                sender.cancel()
                await asyncio.gather(sender, return_exceptions=True)
            self.flush_uplink()
            self.release()
            self._stop.set()

    async def _send_loop(self, websocket: Any) -> None:
        while True:
            preempt = asyncio.create_task(self._preempt_outbound.get())
            audio = asyncio.create_task(self._outbound.get())
            codex_state = asyncio.create_task(self._codex_outbound.get())
            codex_project = asyncio.create_task(self._project_outbound.get())
            done, pending = await asyncio.wait(
                {preempt, audio, codex_state, codex_project},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            if preempt in done:
                await websocket.send(preempt.result())
            if audio in done and not self._is_fenced_playback_message(audio.result()):
                await websocket.send(audio.result())
            if codex_state in done:
                state = codex_state.result()
                if state != self._last_codex_state_sent:
                    await self._send_codex_state(websocket, state)
            if codex_project in done:
                view = codex_project.result()
                if view != self._last_project_view_sent:
                    await websocket.send(codex_project_message(view))
                    self._last_project_view_sent = view
                    self._sync_project_delivery()

    async def _send_codex_state(self, websocket: Any, state: CodexState) -> None:
        task = asyncio.create_task(websocket.send(codex_state_message(state)))
        self._codex_send_task = task
        try:
            await task
        except asyncio.CancelledError:
            if asyncio.current_task().cancelling():
                raise
        else:
            self._last_codex_state_sent = state
        finally:
            if self._codex_send_task is task:
                self._codex_send_task = None
            self._sync_codex_state_delivery()

    def _sync_codex_state_delivery(self) -> None:
        self._clear_codex_outbound()
        if self._authenticated and self._codex_state != self._last_codex_state_sent:
            self._codex_outbound.put_nowait(self._codex_state)

    def _clear_codex_outbound(self) -> None:
        while not self._codex_outbound.empty():
            self._codex_outbound.get_nowait()

    def _sync_project_delivery(self) -> None:
        self._clear_project_outbound()
        if (
            self._authenticated
            and self._project_view is not None
            and self._project_view != self._last_project_view_sent
        ):
            self._project_outbound.put_nowait(self._project_view)

    def _clear_project_outbound(self) -> None:
        while not self._project_outbound.empty():
            self._project_outbound.get_nowait()

    def _cancel_codex_state_send(self) -> None:
        if self._codex_send_task is not None and not self._codex_send_task.done():
            self._codex_send_task.cancel()

    def _enqueue(self, value: str | bytes, *, droppable: bool = False) -> bool:
        try:
            self._outbound.put_nowait(value)
            return True
        except asyncio.QueueFull:
            if not droppable:
                self._stop.set()
            return False

    def _enqueue_preempt(self, value: str) -> bool:
        try:
            self._preempt_outbound.put_nowait(value)
            return True
        except asyncio.QueueFull:
            self._stop.set()
            return False

    def _is_fenced_playback_message(self, value: str | bytes) -> bool:
        if type(value) is bytes:
            return decode_audio_frame(value).generation_epoch <= self._fenced_generation_epoch
        if not value.startswith(('{"type":"caption"', '{"type":"playback.terminal"')):
            return False
        try:
            payload = json.loads(value)
        except json.JSONDecodeError:
            return False
        if payload.get("type") == "caption":
            sequence = payload.get("sequence")
            return (
                payload.get("role") == "assistant"
                and type(sequence) is int
                and sequence <= self._fenced_assistant_caption_sequence
            )
        if payload.get("type") != "playback.terminal":
            return False
        generation_epoch = payload.get("generation_epoch")
        return type(generation_epoch) is int and generation_epoch <= self._fenced_generation_epoch

    def register_ping(self, ping_id: str) -> None:
        if self._clock is not None:
            self._ping_sent[ping_id] = self._clock.now()

    def send_clock_pings(self, count: int = 5) -> None:
        if self._clock is None or self._telemetry is None:
            return
        for index in range(count):
            ping_id = f"ping-{index}"
            self.register_ping(ping_id)
            self._enqueue(
                json.dumps(
                    {"type": "clock.ping", "ping_id": ping_id},
                    ensure_ascii=True,
                    separators=(",", ":"),
                ),
                droppable=True,
            )

    def _record_uplink(self, size: int) -> None:
        if self._telemetry is None or self._clock is None:
            return
        self._uplink_frames += 1
        self._uplink_bytes += size
        if self._clock.now() - self._uplink_flushed_at >= 1.0:
            self.flush_uplink()

    def flush_uplink(self) -> None:
        """Emit the pending uplink bucket; sub-second tails flush at teardown."""
        if self._telemetry is None or self._clock is None or self._uplink_frames == 0:
            return
        self._telemetry.record(
            "mic.uplink_summary",
            {"frames": self._uplink_frames, "bytes": self._uplink_bytes},
        )
        self._uplink_frames = 0
        self._uplink_bytes = 0
        self._uplink_flushed_at = self._clock.now()

    def _record_sync_sample(self, ping_id: str, t_render_ms: float) -> None:
        if self._telemetry is None or self._clock is None:
            return
        sent = self._ping_sent.pop(ping_id, None)
        if sent is None:
            return
        self._telemetry.record(
            "clock.sync_sample",
            {
                "ping_id": ping_id,
                "t_sent": sent,
                "t_received": self._clock.now(),
                "t_render_ms": t_render_ms,
            },
        )


def _validate_playback_frame(frame: PlaybackFrame) -> None:
    _plain_identifier(frame.utterance_id)
    _plain_positive_integer(frame.generation_epoch)
    if type(frame.sequence) is not int or frame.sequence < 0:
        raise DesktopProtocolError("desktop audio sequence is invalid")
    if type(frame.pcm) is not bytes or not frame.pcm or len(frame.pcm) % 2:
        raise DesktopProtocolError("desktop audio must be aligned PCM16 bytes")


def _identifier(value: Any, field: str) -> str:
    if type(value) is not dict:
        raise DesktopProtocolError("desktop frame payload is invalid")
    candidate = value.get(field)
    try:
        return _plain_identifier(candidate)
    except DesktopProtocolError as exc:
        raise DesktopProtocolError(f"desktop {field} is invalid") from exc


def _positive_integer(value: Any, field: str) -> int:
    if type(value) is not dict:
        raise DesktopProtocolError("desktop frame payload is invalid")
    try:
        return _plain_positive_integer(value.get(field))
    except DesktopProtocolError as exc:
        raise DesktopProtocolError(f"desktop {field} is invalid") from exc


def _nonnegative_integer(value: Any, field: str) -> int:
    if type(value) is not dict:
        raise DesktopProtocolError("desktop frame payload is invalid")
    candidate = value.get(field)
    if type(candidate) is not int or candidate < 0:
        raise DesktopProtocolError(f"desktop {field} is invalid")
    return candidate


def _plain_identifier(value: Any) -> str:
    if type(value) is not str or not value.strip() or len(value) > 256:
        raise DesktopProtocolError("desktop identity is invalid")
    return value


def _plain_positive_integer(value: Any) -> int:
    if type(value) is not int or value < 1:
        raise DesktopProtocolError("desktop generation is invalid")
    return value


def _optional_played_ms(payload: dict[str, str | int]) -> int | None:
    value = payload.get("played_ms")
    return None if value is None else int(value)


def delivery_to_event(completion: PlaybackCompletion) -> AssistantSpoken | None:
    """Map a delivery report to the Memory event; words nobody heard yield None."""
    if completion.disposition == "suppressed" or not completion.text:
        return None
    return AssistantSpoken(
        text=completion.text,
        utterance_id=completion.utterance_id,
        delivery=completion.disposition,
        played_ms=completion.played_ms,
    )


def _post_delivery(assembly: Any, completion: PlaybackCompletion) -> None:
    if assembly is None:
        return
    event = delivery_to_event(completion)
    if event is not None:
        assembly.runtime.post(event)


class _NullSink:
    def emit(self, utterance_id: str, text: str) -> None:
        del utterance_id, text

    def end(self, utterance_id: str) -> None:
        del utterance_id


def _desktop_settings() -> Any:
    from nova_audio_agent.config import ConfigurationError, Settings

    raw_env_file = os.environ.get("NOVA_AUDIO_AGENT_ENV_FILE", "").strip()
    if not raw_env_file:
        return Settings()
    env_file = Path(raw_env_file)
    if not env_file.is_absolute() or not env_file.is_file():
        raise ConfigurationError("NOVA_AUDIO_AGENT_ENV_FILE 必须是已存在的绝对普通文件")
    return Settings(_env_file=env_file)


def _parse_ready_endpoint(raw_endpoint: str) -> tuple[str, int]:
    """Split ``127.0.0.1:<port>`` into the loopback host and its port."""

    from nova_audio_agent.config import ConfigurationError

    invalid = "NOVA_AUDIO_AGENT_DESKTOP_READY_ENDPOINT 无效"
    host, separator, raw_port = raw_endpoint.strip().rpartition(":")
    if not separator or host != "127.0.0.1":
        raise ConfigurationError(invalid)
    try:
        port = int(raw_port)
    except ValueError as exc:
        raise ConfigurationError(invalid) from exc
    if not 1 <= port <= 65535:
        raise ConfigurationError(invalid)
    return host, port


async def _run_desktop(
    *,
    token: str | None = None,
    ready_endpoint: str | None = None,
    parent_fd: int = 0,
    settings: Any = None,
    build_assembly: Any = None,
    serve_websocket: Any = None,
    open_ready_connection: Any = None,
    install_signal_handlers: bool = True,
) -> None:
    from nova_audio_agent.config import ConfigurationError

    if build_assembly is None:
        from nova_audio_agent.assembly import build_realtime_assembly

        build_assembly = build_realtime_assembly
    if serve_websocket is None:
        from websockets.asyncio.server import serve

        serve_websocket = serve
    if open_ready_connection is None:
        open_ready_connection = asyncio.open_connection
    if settings is None:
        settings = _desktop_settings()
    token = os.environ.get("NOVA_AUDIO_AGENT_DESKTOP_TOKEN", "") if token is None else token
    if len(token) != 32 or any(character not in "0123456789abcdef" for character in token):
        raise ConfigurationError("NOVA_AUDIO_AGENT_DESKTOP_TOKEN 必须是 128-bit 十六进制值")
    if ready_endpoint is None:
        ready_endpoint = os.environ.get("NOVA_AUDIO_AGENT_DESKTOP_READY_ENDPOINT", "")
    ready_host, ready_port = _parse_ready_endpoint(ready_endpoint)
    raw_video_file = os.environ.get("NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE", "").strip()
    camera_file = Path(raw_video_file) if raw_video_file else None
    if camera_file is not None and not camera_file.is_absolute():
        raise ConfigurationError("NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE 必须是绝对路径")

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    installed_signals: list[signal.Signals] = []
    if install_signal_handlers:
        for signal_name in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(signal_name, stop.set)
                installed_signals.append(signal_name)
            except NotImplementedError:  # pragma: no cover - Windows event loops
                pass
    unwatch_parent = watch_parent_stdin(loop, stop, fd=parent_fd)
    bridge: DesktopSocketBridge | None = None
    assembly = None
    telemetry = None
    telemetry_path = os.environ.get("NOVA_AUDIO_AGENT_REALTIME_TELEMETRY", "").strip()
    if telemetry_path:
        from nova_audio_agent.clock import RealClock
        from nova_audio_agent.realtime.telemetry import JsonlTelemetry

        telemetry = JsonlTelemetry(telemetry_path, clock=RealClock())
    try:
        assembly = build_assembly(
            settings,
            camera_source="file" if camera_file is not None else "local",
            camera_file=camera_file,
            sink=_NullSink(),
            on_audio_frame=lambda frame: (
                bridge.on_audio_frame(frame) if bridge is not None else None
            ),
            on_audio_clear=lambda utterance_id, epoch: (
                bridge.on_audio_clear(utterance_id, epoch) if bridge is not None else None
            ),
            on_audio_alert=lambda utterance_id, epoch: (
                bridge.on_audio_alert(utterance_id, epoch) if bridge is not None else None
            ),
            on_audio_terminal=lambda utterance_id, epoch: (
                bridge.on_audio_terminal(utterance_id, epoch) if bridge is not None else None
            ),
            on_codex_state=lambda state: (
                bridge.on_codex_state(state) if bridge is not None else None
            ),
            on_codex_project=lambda view: (
                bridge.on_codex_project(view) if bridge is not None else None
            ),
            on_spoken=lambda _text: None,
            on_delivery=lambda completion: _post_delivery(assembly, completion),
            on_caption=lambda frame: bridge.on_caption(frame) if bridge is not None else None,
            realtime_telemetry=telemetry,
        )
        project_adapter = getattr(assembly, "codex_live_adapter", None)
        initial_project_view = (
            project_adapter.public_project_view(
                pending_confirmation=project_adapter.confirmation.pending
            )
            if hasattr(project_adapter, "store") and hasattr(project_adapter, "confirmation")
            else None
        )
        bridge = DesktopSocketBridge(
            token=token,
            service=assembly.service,
            stop=stop,
            memory_board=lambda request_id: memory_board_message(
                request_id, assembly.runtime.memory
            ),
            clock=assembly.runtime.clock if telemetry is not None else None,
            telemetry=telemetry,
            project_view=initial_project_view,
        )
        async with serve_websocket(
            bridge.handle,
            "127.0.0.1",
            0,
            max_size=MAX_DESKTOP_PCM_BYTES + MAX_AUDIO_HEADER_BYTES + 6,
            max_queue=16,
        ) as server:
            sockets = server.sockets
            if not sockets:
                raise RuntimeError("desktop loopback server did not bind")
            port = int(sockets[0].getsockname()[1])
            await assembly.start()
            readiness = json.dumps(
                {"token": token, "host": "127.0.0.1", "port": port},
                separators=(",", ":"),
            )
            _, ready_writer = await open_ready_connection(ready_host, ready_port)
            try:
                ready_writer.write(f"{readiness}\n".encode())
                await ready_writer.drain()
            finally:
                ready_writer.close()
                await ready_writer.wait_closed()
            external_stop = asyncio.create_task(stop.wait())
            service_stop = asyncio.create_task(assembly.service.wait_stopped())
            done, pending = await asyncio.wait(
                {external_stop, service_stop},
                return_when=asyncio.FIRST_COMPLETED,
            )
            del done
            stop.set()
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
    finally:
        try:
            if assembly is not None:
                await assembly.stop()
        finally:
            if telemetry is not None:
                telemetry.close()
            unwatch_parent()
            for signal_name in installed_signals:
                loop.remove_signal_handler(signal_name)


def watch_parent_stdin(
    loop: asyncio.AbstractEventLoop,
    stop: asyncio.Event,
    fd: int = 0,
) -> Callable[[], None]:
    """Request a drain when the desktop parent closes this process' stdin.

    The parent never writes to stdin, so a readable descriptor can only mean EOF:
    either the deliberate ``stdin.end()`` of a graceful quit or a dead parent that
    left this process orphaned. Either way the answer is the same drain.

    POSIX loops watch the descriptor directly. Proactor loops have no
    ``add_reader`` at all, so a daemon thread blocks on the read there and hands
    the verdict back to the loop; without it, orphan detection would silently
    disappear off POSIX. Returns the matching unwatch callable.
    """

    if os.name == "posix":
        try:
            loop.add_reader(fd, _consume_parent_liveness, loop, fd, stop)
        except PermissionError:  # pragma: no cover - stdin the selector cannot poll
            # A descriptor the selector refuses is not one a blocking read can
            # judge either: a regular file reports EOF that says nothing about the
            # parent, so stay unwatched rather than invent a shutdown.
            return _no_unwatch
        except NotImplementedError:
            # A POSIX build can still be handed a loop without readers: fall
            # through to the thread instead of losing the sentinel.
            pass
        else:
            return lambda: _release_parent_reader(loop, fd)

    def watch() -> None:
        while True:
            try:
                alive = os.read(fd, 1)
            except OSError:
                break
            if not alive:
                break
        try:
            loop.call_soon_threadsafe(stop.set)
        except RuntimeError:  # pragma: no cover - the loop already finished draining
            pass

    threading.Thread(target=watch, name="nova-parent-liveness", daemon=True).start()
    return _no_unwatch


def _no_unwatch() -> None:
    """Nothing to unregister: the liveness thread is a daemon and dies with exit."""


def _consume_parent_liveness(
    loop: asyncio.AbstractEventLoop, parent_fd: int, stop: asyncio.Event
) -> None:
    """Read one byte; an empty read is EOF, which is the parent asking for a drain.

    Selector readers are level-triggered, and a descriptor at EOF stays readable forever, so
    a reader left registered here would be re-armed on every pass of the loop for the whole
    drain — a busy spin over exactly the window the drain needs the CPU for. Unregistering
    from inside the callback is safe: the verdict is one-shot, and nothing re-arms it.
    """
    try:
        alive = os.read(parent_fd, 1)
    except OSError:
        alive = b""
    if alive:
        return
    _release_parent_reader(loop, parent_fd)
    stop.set()


def _release_parent_reader(loop: asyncio.AbstractEventLoop, parent_fd: int) -> None:
    """Unregister the liveness reader, tolerating a descriptor that no longer has one.

    `remove_reader` returns `False` rather than raising, both for an fd it is not watching
    and for a loop that has already been closed, so the EOF callback and the final cleanup
    can both call it. Its one `RuntimeError` comes from the transport check, which fires
    only for an fd some transport has adopted; this pipe end never is one, so the guard
    below is defensive rather than a path either caller is expected to take.
    """
    try:
        loop.remove_reader(parent_fd)
    except RuntimeError:  # pragma: no cover - defensive: no transport ever adopts this fd
        pass


def main() -> None:
    asyncio.run(_run_desktop())


if __name__ == "__main__":
    main()
