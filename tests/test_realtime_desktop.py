from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.config import ConfigurationError
from nova_audio_agent.events import AssistantSpoken
from nova_audio_agent.realtime import desktop as realtime_desktop
from nova_audio_agent.realtime.desktop import (
    DesktopSocketBridge,
    DesktopProtocolError,
    codex_state_message,
    codex_project_message,
    decode_audio_frame,
    delivery_to_event,
    encode_audio_frame,
    parse_client_message,
    playback_alert_message,
    playback_clear_message,
)
from nova_audio_agent.realtime.playback import PlaybackCompletion, PlaybackFrame
from nova_audio_agent.realtime.session import CaptionFrame


def test_desktop_settings_load_explicit_env_file_outside_codex_workspace(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository_env = tmp_path / "repository.env"
    repository_env.write_text(
        "DASHSCOPE_API_KEY=from-file\nTAVILY_API_KEY=tavily-from-file\n",
        encoding="utf-8",
    )
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.chdir(workspace)
    monkeypatch.setenv("NOVA_AUDIO_AGENT_ENV_FILE", str(repository_env))
    monkeypatch.setenv("DASHSCOPE_API_KEY", "from-process")
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)

    settings = realtime_desktop._desktop_settings()

    assert settings.dashscope_api_key is not None
    assert settings.dashscope_api_key.get_secret_value() == "from-process"
    assert settings.tavily_api_key is not None
    assert settings.tavily_api_key.get_secret_value() == "tavily-from-file"


def test_desktop_settings_reject_invalid_explicit_env_file_without_leaking_contents(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    directory = tmp_path / "not-a-file"
    directory.mkdir()
    for candidate in ("relative.env", str(tmp_path / "missing.env"), str(directory)):
        monkeypatch.setenv("NOVA_AUDIO_AGENT_ENV_FILE", candidate)
        with pytest.raises(ConfigurationError, match="NOVA_AUDIO_AGENT_ENV_FILE") as raised:
            realtime_desktop._desktop_settings()
        assert "credential" not in str(raised.value)


def test_first_frame_must_authenticate_without_echoing_token() -> None:
    command = parse_client_message(
        json.dumps({"type": "hello", "token": "a" * 32}),
        expected_token="a" * 32,
        authenticated=False,
    )
    assert command.kind == "authenticated"
    assert command.payload == {}

    with pytest.raises(DesktopProtocolError, match="authentication") as raised:
        parse_client_message(
            json.dumps({"type": "hello", "token": "wrong-secret"}),
            expected_token="a" * 32,
            authenticated=False,
        )
    assert "wrong-secret" not in str(raised.value)


def test_authenticated_control_frames_validate_authoritative_identity() -> None:
    onset = parse_client_message(
        '{"type":"speech.onset","speech_id":"speech-1"}',
        expected_token="unused",
        authenticated=True,
    )
    done = parse_client_message(
        '{"type":"playback.done","utterance_id":"u-1","generation_epoch":2}',
        expected_token="unused",
        authenticated=True,
    )

    assert onset.kind == "speech_onset"
    assert onset.payload == {"speech_id": "speech-1"}
    assert done.kind == "playback_done"
    assert done.payload == {"utterance_id": "u-1", "generation_epoch": 2}

    with pytest.raises(DesktopProtocolError, match="generation"):
        parse_client_message(
            '{"type":"playback.done","utterance_id":"u-1","generation_epoch":0}',
            expected_token="unused",
            authenticated=True,
        )


def test_playback_acknowledgements_carry_optional_positional_evidence() -> None:
    cleared = parse_client_message(
        '{"type":"playback.cleared","utterance_id":"u-1","generation_epoch":2,"played_ms":350}',
        expected_token="unused",
        authenticated=True,
    )
    done = parse_client_message(
        '{"type":"playback.done","utterance_id":"u-1","generation_epoch":2,"played_ms":900}',
        expected_token="unused",
        authenticated=True,
    )
    without_evidence = parse_client_message(
        '{"type":"playback.cleared","utterance_id":"u-1","generation_epoch":2}',
        expected_token="unused",
        authenticated=True,
    )

    assert cleared.kind == "playback_cleared"
    assert cleared.payload == {"utterance_id": "u-1", "generation_epoch": 2, "played_ms": 350}
    assert done.payload == {"utterance_id": "u-1", "generation_epoch": 2, "played_ms": 900}
    assert without_evidence.payload == {"utterance_id": "u-1", "generation_epoch": 2}

    with pytest.raises(DesktopProtocolError, match="played_ms"):
        parse_client_message(
            '{"type":"playback.cleared","utterance_id":"u-1","generation_epoch":2,"played_ms":-1}',
            expected_token="unused",
            authenticated=True,
        )
    with pytest.raises(DesktopProtocolError, match="played_ms"):
        parse_client_message(
            '{"type":"playback.stopped","utterance_id":"u-1","generation_epoch":2,'
            '"played_ms":"soon"}',
            expected_token="unused",
            authenticated=True,
        )


def test_audio_frame_is_atomic_bounded_binary_with_generation_metadata() -> None:
    frame = PlaybackFrame(
        utterance_id="utterance-1",
        generation_epoch=3,
        sequence=7,
        pcm=b"\x00\x01\x02\x03",
    )

    encoded = encode_audio_frame(frame)
    decoded = decode_audio_frame(encoded)

    assert decoded == frame
    assert b"utterance-1" in encoded

    with pytest.raises(DesktopProtocolError, match="PCM16"):
        decode_audio_frame(encoded[:-1])


def test_playback_clear_contains_no_provider_identity() -> None:
    message = playback_clear_message("utterance-1", 4)

    assert json.loads(message) == {
        "type": "playback.clear",
        "utterance_id": "utterance-1",
        "generation_epoch": 4,
    }
    assert "response" not in message


def test_playback_alert_encodes_combined_identity_or_tone_only() -> None:
    assert json.loads(playback_alert_message("old", 3)) == {
        "type": "playback.alert",
        "utterance_id": "old",
        "generation_epoch": 3,
    }
    assert json.loads(playback_alert_message(None, None)) == {
        "type": "playback.alert",
    }

    with pytest.raises(DesktopProtocolError, match="identity"):
        playback_alert_message("old", None)
    with pytest.raises(DesktopProtocolError, match="identity"):
        playback_alert_message(None, 3)


def test_codex_state_message_is_bounded_to_idle_or_running() -> None:
    assert json.loads(codex_state_message("running")) == {
        "type": "codex.state",
        "state": "running",
    }
    with pytest.raises(DesktopProtocolError, match="Codex state"):
        codex_state_message("busy")  # type: ignore[arg-type]


def test_codex_project_message_has_closed_public_shape() -> None:
    from nova_audio_agent.executors.codex_projects import PublicProjectView

    assert json.loads(codex_project_message(PublicProjectView("alpha", "Task 1", True))) == {
        "type": "codex.project",
        "workspace_display_name": "alpha",
        "session_title": "Task 1",
        "pending_confirmation": True,
        "pending_action": None,
        "pending_workspace_display_name": None,
        "pending_session_title": None,
        "pending_expires_in_seconds": None,
    }

    with pytest.raises(DesktopProtocolError, match="project view"):
        codex_project_message(
            PublicProjectView(
                "alpha",
                None,
                True,
                pending_action=[],  # type: ignore[arg-type]
            )
        )


def test_delivery_events_exclude_suppressed_speech() -> None:
    """Words nobody heard must never be posted into the conversation."""

    def completion(disposition: str, played_ms: int) -> PlaybackCompletion:
        return PlaybackCompletion(
            session_epoch=1,
            response_id="response-1",
            utterance_id="utterance-1",
            generation_epoch=1,
            text="内容",
            disposition=disposition,  # type: ignore[arg-type]
            started=disposition != "suppressed",
            played_ms=played_ms,
        )

    spoken = delivery_to_event(completion("spoken", 900))
    interrupted = delivery_to_event(completion("interrupted", 120))

    assert isinstance(spoken, AssistantSpoken)
    assert spoken.delivery == "spoken"
    assert spoken.text == "内容"
    assert spoken.utterance_id == "utterance-1"
    assert spoken.played_ms == 900
    assert isinstance(interrupted, AssistantSpoken)
    assert interrupted.delivery == "interrupted"
    assert delivery_to_event(completion("suppressed", 0)) is None


def test_json_and_pcm_bounds_fail_closed() -> None:
    with pytest.raises(DesktopProtocolError, match="large"):
        parse_client_message(
            " " * 20_000,
            expected_token="unused",
            authenticated=True,
        )


def test_clock_pong_and_render_timestamps_parse_as_telemetry_evidence() -> None:
    pong = parse_client_message(
        '{"type":"clock.pong","ping_id":"ping-1","t_render_ms":123.5}',
        expected_token="unused",
        authenticated=True,
    )
    stamped = parse_client_message(
        '{"type":"playback.started","utterance_id":"u-1","generation_epoch":2,"t_render_ms":88.25}',
        expected_token="unused",
        authenticated=True,
    )

    assert pong.kind == "clock_pong"
    assert pong.payload == {"ping_id": "ping-1", "t_render_ms": 123.5}
    assert stamped.payload == {
        "utterance_id": "u-1",
        "generation_epoch": 2,
        "t_render_ms": 88.25,
    }

    with pytest.raises(DesktopProtocolError, match="t_render_ms"):
        parse_client_message(
            '{"type":"clock.pong","ping_id":"ping-1","t_render_ms":-1}',
            expected_token="unused",
            authenticated=True,
        )


@pytest.mark.asyncio
async def test_bridge_records_renderer_acks_uplink_summaries_and_sync_samples() -> None:
    class _Service:
        async def send_audio(self, pcm: bytes) -> None:
            del pcm

        def playback_started(self, *_args: object) -> bool:
            return True

    records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            records.append((kind, payload))

    clock = VirtualClock()
    bridge = DesktopSocketBridge(
        token="a" * 32,
        service=_Service(),  # type: ignore[arg-type]
        stop=asyncio.Event(),
        clock=clock,
        telemetry=_Telemetry(),
    )

    await bridge.receive(b"\x00\x01", authenticated=True)
    await bridge.receive(b"\x00\x01\x02\x03", authenticated=True)
    assert [kind for kind, _payload in records] == []

    clock.advance_to(1.5)
    await bridge.receive(b"\x00\x01", authenticated=True)
    assert records == [("mic.uplink_summary", {"frames": 3, "bytes": 8})]

    await bridge.receive(
        '{"type":"playback.started","utterance_id":"u-1","generation_epoch":2,"t_render_ms":88.25}',
        authenticated=True,
    )
    assert records[-1] == (
        "renderer.ack",
        {
            "kind": "playback_started",
            "utterance_id": "u-1",
            "generation_epoch": 2,
            "t_render_ms": 88.25,
        },
    )

    bridge.register_ping("ping-1")
    clock.advance_to(2.0)
    await bridge.receive(
        '{"type":"clock.pong","ping_id":"ping-1","t_render_ms":321.0}',
        authenticated=True,
    )
    assert records[-1] == (
        "clock.sync_sample",
        {"ping_id": "ping-1", "t_sent": 1.5, "t_received": 2.0, "t_render_ms": 321.0},
    )


def test_bridge_records_first_frame_enqueued_and_clear_sent() -> None:
    class _Service:
        pass

    records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            records.append((kind, payload))

    bridge = DesktopSocketBridge(
        token="a" * 32,
        service=_Service(),  # type: ignore[arg-type]
        stop=asyncio.Event(),
        clock=VirtualClock(),
        telemetry=_Telemetry(),
    )

    bridge.on_audio_frame(
        PlaybackFrame(utterance_id="u-1", generation_epoch=1, sequence=0, pcm=b"\x00\x01")
    )
    bridge.on_audio_frame(
        PlaybackFrame(utterance_id="u-1", generation_epoch=1, sequence=1, pcm=b"\x00\x01")
    )
    bridge.on_audio_clear("u-1", 1)
    bridge.on_audio_alert(None, None)

    assert records == [
        ("playback.first_frame_enqueued", {"utterance_id": "u-1", "generation_epoch": 1}),
        ("playback.clear_sent", {"utterance_id": "u-1", "generation_epoch": 1}),
        ("renderer.alert_tone_sent", {"generation_qualified": False}),
    ]


@pytest.mark.asyncio
async def test_audio_clear_overtakes_queued_pcm_and_drops_the_fenced_generation() -> None:
    class _Service:
        codex_state = "idle"

    class _Socket:
        def __init__(self) -> None:
            self.sent: list[str | bytes] = []
            self.first_send_started = asyncio.Event()
            self.release_first_send = asyncio.Event()

        async def send(self, value: str | bytes) -> None:
            if not self.sent:
                self.first_send_started.set()
                await self.release_first_send.wait()
            self.sent.append(value)

    bridge = DesktopSocketBridge(
        token="a" * 32,
        service=_Service(),  # type: ignore[arg-type]
        stop=asyncio.Event(),
    )
    socket = _Socket()
    first = PlaybackFrame("u-1", 1, 0, b"\x00\x01")
    stale = PlaybackFrame("u-1", 1, 1, b"\x02\x03")
    bridge.on_audio_frame(first)
    sender = asyncio.create_task(bridge._send_loop(socket))
    try:
        await asyncio.wait_for(socket.first_send_started.wait(), timeout=0.2)
        bridge.on_audio_frame(stale)
        bridge.on_audio_clear("u-1", 1)
        socket.release_first_send.set()
        for _ in range(10):
            await asyncio.sleep(0)

        assert decode_audio_frame(socket.sent[0]) == first
        assert json.loads(socket.sent[1]) == {
            "type": "playback.clear",
            "utterance_id": "u-1",
            "generation_epoch": 1,
        }
        assert len(socket.sent) == 2
    finally:
        sender.cancel()
        await asyncio.gather(sender, return_exceptions=True)


@pytest.mark.asyncio
async def test_audio_alert_overtakes_old_pcm_but_keeps_replacement_pcm() -> None:
    class _Service:
        codex_state = "idle"

    class _Socket:
        def __init__(self) -> None:
            self.sent: list[str | bytes] = []
            self.first_send_started = asyncio.Event()
            self.release_first_send = asyncio.Event()

        async def send(self, value: str | bytes) -> None:
            if not self.sent:
                self.first_send_started.set()
                await self.release_first_send.wait()
            self.sent.append(value)

    bridge = DesktopSocketBridge(
        token="a" * 32,
        service=_Service(),  # type: ignore[arg-type]
        stop=asyncio.Event(),
    )
    socket = _Socket()
    first = PlaybackFrame("old", 1, 0, b"\x00\x01")
    stale = PlaybackFrame("old", 1, 1, b"\x02\x03")
    replacement = PlaybackFrame("guard", 2, 0, b"\x04\x05")
    bridge.on_audio_frame(first)
    sender = asyncio.create_task(bridge._send_loop(socket))
    try:
        await asyncio.wait_for(socket.first_send_started.wait(), timeout=0.2)
        bridge.on_audio_frame(stale)
        bridge.on_audio_alert("old", 1)
        bridge.on_audio_frame(replacement)
        socket.release_first_send.set()
        for _ in range(50):
            if len(socket.sent) == 3:
                break
            await asyncio.sleep(0)

        assert decode_audio_frame(socket.sent[0]) == first
        assert json.loads(socket.sent[1]) == {
            "type": "playback.alert",
            "utterance_id": "old",
            "generation_epoch": 1,
        }
        assert decode_audio_frame(socket.sent[2]) == replacement
        assert len(socket.sent) == 3
    finally:
        sender.cancel()
        await asyncio.gather(sender, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("preemption", ("clear", "alert"))
async def test_audio_preemption_drops_queued_assistant_caption_but_keeps_user_and_replacement(
    preemption: str,
) -> None:
    class _Service:
        codex_state = "idle"

    class _Socket:
        def __init__(self) -> None:
            self.sent: list[str | bytes] = []
            self.first_send_started = asyncio.Event()
            self.release_first_send = asyncio.Event()

        async def send(self, value: str | bytes) -> None:
            if not self.sent:
                self.first_send_started.set()
                await self.release_first_send.wait()
            self.sent.append(value)

    bridge = DesktopSocketBridge(
        token="a" * 32,
        service=_Service(),  # type: ignore[arg-type]
        stop=asyncio.Event(),
    )
    socket = _Socket()
    first = PlaybackFrame("old", 1, 0, b"\x00\x01")
    bridge.on_audio_frame(first)
    sender = asyncio.create_task(bridge._send_loop(socket))
    try:
        await asyncio.wait_for(socket.first_send_started.wait(), timeout=0.2)
        bridge.on_caption(CaptionFrame(role="assistant", text="旧回复", final=False))
        if preemption == "clear":
            bridge.on_audio_clear("old", 1)
        else:
            bridge.on_audio_alert("old", 1)
        bridge.on_caption(CaptionFrame(role="user", text="用户仍在说", final=True))
        bridge.on_caption(CaptionFrame(role="assistant", text="新的提醒", final=True))
        socket.release_first_send.set()
        for _ in range(50):
            if len(socket.sent) == 4:
                break
            await asyncio.sleep(0)

        assert decode_audio_frame(socket.sent[0]) == first
        assert json.loads(socket.sent[1]) == {
            "type": f"playback.{preemption}",
            "utterance_id": "old",
            "generation_epoch": 1,
        }
        assert [json.loads(message)["text"] for message in socket.sent[2:]] == [
            "用户仍在说",
            "新的提醒",
        ]
        assert len(socket.sent) == 4
    finally:
        sender.cancel()
        await asyncio.gather(sender, return_exceptions=True)


def test_caption_frames_are_droppable_display_messages() -> None:
    class _Service:
        pass

    stop = asyncio.Event()
    bridge = DesktopSocketBridge(
        token="a" * 32,
        service=_Service(),  # type: ignore[arg-type]
        stop=stop,
        max_outbound_frames=1,
    )

    bridge.on_caption(CaptionFrame(role="assistant", text="你好", final=False))
    assert json.loads(bridge._outbound.get_nowait()) == {
        "type": "caption",
        "role": "assistant",
        "text": "你好",
        "final": False,
        "sequence": 1,
    }

    bridge._enqueue("occupies-the-queue")
    bridge.on_caption(CaptionFrame(role="user", text="满了", final=True))
    assert stop.is_set() is False


def test_memory_board_request_requires_plain_request_id() -> None:
    command = parse_client_message(
        '{"type":"memory.board.request","request_id":"board-1"}',
        expected_token="unused",
        authenticated=True,
    )

    assert command.kind == "memory_board_request"
    assert command.payload == {"request_id": "board-1"}

    with pytest.raises(DesktopProtocolError, match="request_id"):
        parse_client_message(
            '{"type":"memory.board.request","request_id":42}',
            expected_token="unused",
            authenticated=True,
        )


def test_non_playback_text_skips_fence_json_parsing(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Service:
        pass

    bridge = DesktopSocketBridge(
        token="a" * 32,
        service=_Service(),  # type: ignore[arg-type]
        stop=asyncio.Event(),
    )
    board_message = '{"type":"memory.board","channels":[' + (" " * (256 * 1024)) + "]}"

    def unexpected_json_loads(_value: str) -> object:
        raise AssertionError("non-playback messages must bypass fence JSON parsing")

    monkeypatch.setattr(realtime_desktop.json, "loads", unexpected_json_loads)

    assert bridge._is_fenced_playback_message(board_message) is False


@pytest.mark.asyncio
async def test_memory_board_request_enqueues_one_bounded_reply() -> None:
    class _Service:
        pass

    bridge = DesktopSocketBridge(
        token="a" * 32,
        service=_Service(),  # type: ignore[arg-type]
        stop=asyncio.Event(),
        memory_board=lambda request_id: f'{{"type":"memory.board","request_id":"{request_id}"}}',
    )

    await bridge.receive(
        '{"type":"memory.board.request","request_id":"board-1"}',
        authenticated=True,
    )

    reply = bridge._outbound.get_nowait()
    assert json.loads(reply) == {"type": "memory.board", "request_id": "board-1"}


@pytest.mark.asyncio
async def test_droppable_frames_never_kill_the_session_on_overflow() -> None:
    class _Service:
        pass

    stop = asyncio.Event()
    bridge = DesktopSocketBridge(
        token="a" * 32,
        service=_Service(),  # type: ignore[arg-type]
        stop=stop,
        max_outbound_frames=1,
        memory_board=lambda request_id: request_id,
    )
    bridge._enqueue("occupies-the-queue")

    await bridge.receive(
        '{"type":"memory.board.request","request_id":"board-1"}',
        authenticated=True,
    )
    assert stop.is_set() is False

    bridge._enqueue("audio-overflow")
    assert stop.is_set() is True


@pytest.mark.asyncio
async def test_bridge_routes_only_validated_renderer_commands_to_service() -> None:
    class _Service:
        codex_state = "idle"

        def __init__(self) -> None:
            self.calls: list[object] = []

        async def send_audio(self, pcm: bytes) -> None:
            self.calls.append(("audio", pcm))

        async def local_speech_onset(self, speech_id: str) -> None:
            self.calls.append(("onset", speech_id))

        def playback_started(self, utterance_id: str, generation_epoch: int) -> bool:
            self.calls.append(("started", utterance_id, generation_epoch))
            return True

        def playback_done(
            self,
            utterance_id: str,
            generation_epoch: int,
            played_ms: int | None = None,
        ) -> bool:
            self.calls.append(("done", utterance_id, generation_epoch, played_ms))
            return True

        async def playback_stopped(
            self,
            utterance_id: str,
            generation_epoch: int,
            played_ms: int | None = None,
        ) -> bool:
            self.calls.append(("stopped", utterance_id, generation_epoch, played_ms))
            return True

        def playback_cleared(
            self,
            utterance_id: str,
            generation_epoch: int,
            played_ms: int | None = None,
        ) -> bool:
            self.calls.append(("cleared", utterance_id, generation_epoch, played_ms))
            return True

    service = _Service()
    bridge = DesktopSocketBridge(
        token="a" * 32,
        service=service,  # type: ignore[arg-type]
        stop=asyncio.Event(),
    )

    assert await bridge.receive(
        json.dumps({"type": "hello", "token": "a" * 32}),
        authenticated=False,
    )
    await bridge.receive(b"\x00\x01", authenticated=True)
    await bridge.receive('{"type":"speech.onset","speech_id":"speech-1"}', authenticated=True)
    await bridge.receive(
        '{"type":"playback.started","utterance_id":"u-1","generation_epoch":2}',
        authenticated=True,
    )
    await bridge.receive(
        '{"type":"playback.done","utterance_id":"u-1","generation_epoch":2,"played_ms":900}',
        authenticated=True,
    )
    await bridge.receive(
        '{"type":"playback.stopped","utterance_id":"u-2","generation_epoch":3}',
        authenticated=True,
    )
    await bridge.receive(
        '{"type":"playback.cleared","utterance_id":"u-2","generation_epoch":3,"played_ms":0}',
        authenticated=True,
    )

    assert service.calls == [
        ("audio", b"\x00\x01"),
        ("onset", "speech-1"),
        ("started", "u-1", 2),
        ("done", "u-1", 2, 900),
        ("stopped", "u-2", 3, None),
        ("cleared", "u-2", 3, 0),
    ]


def test_bridge_allows_only_one_desktop_client() -> None:
    class _Service:
        codex_state = "idle"

    bridge = DesktopSocketBridge(
        token="a" * 32,
        service=_Service(),  # type: ignore[arg-type]
        stop=asyncio.Event(),
    )

    assert bridge.claim() is True
    assert bridge.claim() is False
    bridge.release()
    assert bridge.claim() is True


def test_bridge_rejects_non_hexadecimal_token() -> None:
    with pytest.raises(ValueError, match="128-bit hexadecimal"):
        DesktopSocketBridge(
            token="z" * 32,
            service=object(),  # type: ignore[arg-type]
            stop=asyncio.Event(),
        )


def test_bridge_suppresses_duplicate_codex_state_updates() -> None:
    service = SimpleNamespace(codex_state="idle")
    bridge = DesktopSocketBridge(
        token="a" * 32,
        service=service,  # type: ignore[arg-type]
        stop=asyncio.Event(),
    )
    assert bridge.claim()
    bridge._authenticated = True

    bridge.on_codex_state("running")
    bridge.on_codex_state("running")

    assert bridge._codex_outbound.qsize() == 1


def test_bridge_keeps_runtime_running_when_audio_queue_is_full_during_state_update() -> None:
    stop = asyncio.Event()
    bridge = DesktopSocketBridge(
        token="a" * 32,
        service=SimpleNamespace(codex_state="idle"),  # type: ignore[arg-type]
        stop=stop,
        max_outbound_frames=1,
    )
    assert bridge.claim()
    bridge.on_audio_terminal("utterance-1", 1)

    bridge.on_codex_state("running")

    assert not stop.is_set()


@pytest.mark.asyncio
async def test_authenticated_client_disconnect_requests_backend_cleanup() -> None:
    class _Service:
        codex_state = "idle"

    class _Socket:
        def __init__(self) -> None:
            self.sent: list[str | bytes] = []

        async def recv(self) -> str:
            return json.dumps({"type": "hello", "token": "a" * 32})

        async def send(self, value: str | bytes) -> None:
            self.sent.append(value)

        async def close(self, *, code: int, reason: str) -> None:
            del code, reason

        def __aiter__(self):
            async def empty():
                if False:
                    yield "unused"

            return empty()

    stop = asyncio.Event()
    bridge = DesktopSocketBridge(
        token="a" * 32,
        service=_Service(),  # type: ignore[arg-type]
        stop=stop,
    )
    socket = _Socket()

    await bridge.handle(socket)

    assert stop.is_set()
    assert socket.sent == [
        '{"type":"desktop.ready"}',
        '{"type":"codex.state","state":"idle"}',
    ]
    with pytest.raises(DesktopProtocolError, match="large"):
        encode_audio_frame(
            PlaybackFrame(
                utterance_id="u-1",
                generation_epoch=1,
                sequence=0,
                pcm=b"\x00\x00" * 40_000,
            )
        )


@pytest.mark.asyncio
async def test_bridge_sends_latest_codex_state_after_authentication() -> None:
    class _Service:
        codex_state = "idle"

    class _Socket:
        def __init__(self) -> None:
            self.sent: list[str | bytes] = []

        async def recv(self) -> str:
            return json.dumps({"type": "hello", "token": "a" * 32})

        async def send(self, value: str | bytes) -> None:
            self.sent.append(value)

        async def close(self, *, code: int, reason: str) -> None:
            del code, reason

        def __aiter__(self):
            async def empty():
                if False:
                    yield "unused"

            return empty()

    bridge = DesktopSocketBridge(
        token="a" * 32,
        service=_Service(),  # type: ignore[arg-type]
        stop=asyncio.Event(),
    )
    bridge.on_codex_state("running")
    socket = _Socket()

    await bridge.handle(socket)

    assert socket.sent[:2] == [
        '{"type":"desktop.ready"}',
        '{"type":"codex.state","state":"running"}',
    ]


@pytest.mark.asyncio
async def test_bridge_drops_pre_authentication_state_updates_after_sending_latest_state() -> None:
    class _Service:
        codex_state = "idle"

    class _Socket:
        def __init__(self) -> None:
            self.sent: list[str | bytes] = []

        async def recv(self) -> str:
            bridge.on_codex_state("running")
            bridge.on_codex_state("idle")
            bridge.on_codex_state("running")
            return json.dumps({"type": "hello", "token": "a" * 32})

        async def send(self, value: str | bytes) -> None:
            self.sent.append(value)

        async def close(self, *, code: int, reason: str) -> None:
            del code, reason

        def __aiter__(self):
            async def empty():
                await asyncio.sleep(0)
                if False:
                    yield "unused"

            return empty()

    bridge = DesktopSocketBridge(
        token="a" * 32,
        service=_Service(),  # type: ignore[arg-type]
        stop=asyncio.Event(),
    )
    socket = _Socket()

    await bridge.handle(socket)

    assert socket.sent == [
        '{"type":"desktop.ready"}',
        '{"type":"codex.state","state":"running"}',
    ]


@pytest.mark.asyncio
async def test_bridge_cancels_taken_state_when_a_newer_state_arrives_before_send_completes() -> (
    None
):
    class _Service:
        codex_state = "idle"

    class _Socket:
        def __init__(self) -> None:
            self.sent: list[str | bytes] = []
            self.running_send_started = asyncio.Event()
            self.running_send_cancelled = asyncio.Event()
            self.release_running_send = asyncio.Event()
            self.close_input = asyncio.Event()

        async def recv(self) -> str:
            return json.dumps({"type": "hello", "token": "a" * 32})

        async def send(self, value: str | bytes) -> None:
            if value == '{"type":"codex.state","state":"running"}':
                self.running_send_started.set()
                try:
                    await self.release_running_send.wait()
                except asyncio.CancelledError:
                    self.running_send_cancelled.set()
                    raise
            self.sent.append(value)

        async def close(self, *, code: int, reason: str) -> None:
            del code, reason

        def __aiter__(self):
            async def empty():
                await self.close_input.wait()
                if False:
                    yield "unused"

            return empty()

    bridge = DesktopSocketBridge(
        token="a" * 32,
        service=_Service(),  # type: ignore[arg-type]
        stop=asyncio.Event(),
    )
    socket = _Socket()
    task = asyncio.create_task(bridge.handle(socket))
    try:
        await asyncio.sleep(0)
        bridge.on_codex_state("running")
        await asyncio.wait_for(socket.running_send_started.wait(), timeout=0.2)

        bridge.on_codex_state("idle")
        await asyncio.wait_for(socket.running_send_cancelled.wait(), timeout=0.2)
        socket.release_running_send.set()
        await asyncio.sleep(0)

        assert socket.sent == [
            '{"type":"desktop.ready"}',
            '{"type":"codex.state","state":"idle"}',
        ]
    finally:
        socket.release_running_send.set()
        socket.close_input.set()
        await asyncio.wait_for(task, timeout=0.2)


def test_audio_overflow_does_not_drop_the_independent_preemption_control() -> None:
    """A full media queue drops/records media accurately but cannot strand clear."""

    class _Service:
        pass

    class _Telemetry:
        def __init__(self) -> None:
            self.records: list[tuple[str, dict]] = []

        def record(self, kind: str, payload: dict) -> None:
            self.records.append((kind, payload))

    telemetry = _Telemetry()
    stop = asyncio.Event()
    bridge = DesktopSocketBridge(
        token="a" * 32,
        service=_Service(),  # type: ignore[arg-type]
        stop=stop,
        max_outbound_frames=1,
        clock=VirtualClock(),
        telemetry=telemetry,  # type: ignore[arg-type]
    )
    bridge.on_audio_terminal("u-0", 1)

    bridge.on_audio_frame(
        PlaybackFrame(utterance_id="u-1", generation_epoch=1, sequence=0, pcm=b"\x00\x01")
    )
    bridge.on_audio_clear("u-1", 1)

    kinds = [kind for kind, _payload in telemetry.records]
    assert "playback.first_frame_enqueued" not in kinds
    assert "playback.clear_sent" in kinds
    assert json.loads(bridge._preempt_outbound.get_nowait()) == {
        "type": "playback.clear",
        "utterance_id": "u-1",
        "generation_epoch": 1,
    }


def test_uplink_tail_bucket_is_flushed_on_demand() -> None:
    """A sub-second session must not lose its only uplink summary."""

    class _Service:
        pass

    class _Telemetry:
        def __init__(self) -> None:
            self.records: list[tuple[str, dict]] = []

        def record(self, kind: str, payload: dict) -> None:
            self.records.append((kind, payload))

    telemetry = _Telemetry()
    bridge = DesktopSocketBridge(
        token="a" * 32,
        service=_Service(),  # type: ignore[arg-type]
        stop=asyncio.Event(),
        clock=VirtualClock(),
        telemetry=telemetry,  # type: ignore[arg-type]
    )
    bridge._record_uplink(320)
    assert telemetry.records == []

    bridge.flush_uplink()

    assert telemetry.records == [("mic.uplink_summary", {"frames": 1, "bytes": 320})]
    bridge.flush_uplink()
    assert len(telemetry.records) == 1
