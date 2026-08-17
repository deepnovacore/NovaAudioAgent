from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from nova_audio_agent.config import ConfigurationError
from nova_audio_agent.realtime import desktop as realtime_desktop
from nova_audio_agent.realtime.desktop import _run_desktop, watch_parent_stdin

READY_ENDPOINT = "127.0.0.1:51515"


class _ThreadOnlyLoop:
    """Stands in for a Windows Proactor loop: no ``add_reader``, threadsafe calls work.

    ``add_reader_calls`` is the evidence: the off-POSIX branch must never reach
    it, while the fallback branch must try it exactly once before threading.
    """

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self.add_reader_calls = 0

    def add_reader(self, *args: object) -> None:
        del args
        self.add_reader_calls += 1
        raise NotImplementedError("Proactor event loops have no add_reader")

    def remove_reader(self, *args: object) -> None:
        del args
        raise AssertionError("the thread fallback owns no loop reader to remove")

    def call_soon_threadsafe(self, callback: Any, *args: object) -> object:
        return self._loop.call_soon_threadsafe(callback, *args)


@pytest.mark.asyncio
async def test_parent_watch_stops_on_stdin_eof_through_the_loop_reader() -> None:
    """POSIX loops watch the fd directly: the parent's closed end means stop."""

    parent_read, parent_write = os.pipe()
    stop = asyncio.Event()
    unwatch = watch_parent_stdin(asyncio.get_running_loop(), stop, fd=parent_read)
    try:
        assert stop.is_set() is False
        os.close(parent_write)
        await asyncio.wait_for(stop.wait(), timeout=1.0)
    finally:
        unwatch()
        os.close(parent_read)


@pytest.mark.real_time
@pytest.mark.asyncio
async def test_parent_watch_threads_stdin_eof_when_the_loop_has_no_reader() -> None:
    """A loop without ``add_reader`` must not silently lose orphan detection."""

    parent_read, parent_write = os.pipe()
    stop = asyncio.Event()
    loop = _ThreadOnlyLoop(asyncio.get_running_loop())
    unwatch = watch_parent_stdin(loop, stop, fd=parent_read)  # type: ignore[arg-type]
    try:
        assert loop.add_reader_calls == 1
        assert stop.is_set() is False
        os.close(parent_write)
        await asyncio.wait_for(stop.wait(), timeout=1.0)
    finally:
        unwatch()
        os.close(parent_read)


@pytest.mark.real_time
@pytest.mark.asyncio
async def test_parent_watch_never_registers_a_loop_reader_off_posix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Off POSIX a selector reader on stdin is not merely unsupported, it is unsafe."""

    monkeypatch.setattr(realtime_desktop.os, "name", "nt")
    parent_read, parent_write = os.pipe()
    stop = asyncio.Event()
    loop = _ThreadOnlyLoop(asyncio.get_running_loop())
    unwatch = watch_parent_stdin(loop, stop, fd=parent_read)  # type: ignore[arg-type]
    try:
        assert loop.add_reader_calls == 0
        os.close(parent_write)
        await asyncio.wait_for(stop.wait(), timeout=1.0)
    finally:
        unwatch()
        os.close(parent_read)


class _ReadyWriter:
    def __init__(self, written: asyncio.Event) -> None:
        self._written = written
        self.chunks: list[bytes] = []
        self.drains = 0
        self.closed = False
        self.awaited_closed = False
        self.drain_error: OSError | None = None

    def write(self, payload: bytes) -> None:
        self.chunks.append(payload)

    async def drain(self) -> None:
        if self.drain_error is not None:
            raise self.drain_error
        self.drains += 1
        self._written.set()

    def close(self) -> None:
        self.closed = True

    async def wait_closed(self) -> None:
        self.awaited_closed = True

    def payload(self) -> bytes:
        return b"".join(self.chunks)


class _ReadyDialer:
    """Fake ``asyncio.open_connection`` recording the dial target and the payload."""

    def __init__(self, *, on_dial: Any = None, drain_error: OSError | None = None) -> None:
        self.written = asyncio.Event()
        self.targets: list[tuple[str, int]] = []
        self.writer = _ReadyWriter(self.written)
        self.writer.drain_error = drain_error
        self._on_dial = on_dial

    async def __call__(self, host: str, port: int) -> tuple[object, _ReadyWriter]:
        self.targets.append((host, port))
        if self._on_dial is not None:
            self._on_dial()
        return object(), self.writer


@pytest.mark.asyncio
async def test_desktop_entry_reports_readiness_and_stops_on_parent_eof(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE", "")
    parent_read, parent_write = os.pipe()
    lifecycle: list[str] = []
    service_stopped = asyncio.Event()
    dialer = _ReadyDialer(on_dial=lambda: lifecycle.append("ready"))

    class _Assembly:
        service = SimpleNamespace(codex_state="idle", wait_stopped=service_stopped.wait)

        async def start(self) -> None:
            lifecycle.append("start")

        async def stop(self) -> None:
            lifecycle.append("stop")

    class _BoundSocket:
        def getsockname(self) -> tuple[str, int]:
            return ("127.0.0.1", 43123)

    class _Server:
        sockets = [_BoundSocket()]

        async def __aenter__(self) -> _Server:
            return self

        async def __aexit__(self, *args: object) -> None:
            del args

    def build_assembly(_settings: object, **callbacks: Any) -> _Assembly:
        assert callbacks["camera_source"] == "local"
        assert callbacks["camera_file"] is None
        assert set(callbacks) >= {
            "on_audio_frame",
            "on_audio_clear",
            "on_audio_alert",
            "on_audio_terminal",
            "on_codex_state",
        }
        return _Assembly()

    def serve_websocket(*args: object, **kwargs: object) -> _Server:
        del args, kwargs
        return _Server()

    task = asyncio.create_task(
        _run_desktop(
            token="a" * 32,
            ready_endpoint=READY_ENDPOINT,
            parent_fd=parent_read,
            settings=object(),
            build_assembly=build_assembly,
            serve_websocket=serve_websocket,
            open_ready_connection=dialer,
            install_signal_handlers=False,
        )
    )
    try:
        await asyncio.wait_for(dialer.written.wait(), timeout=0.2)
        assert dialer.targets == [("127.0.0.1", 51515)]
        payload = dialer.writer.payload()
        assert payload.endswith(b"\n")
        assert payload.count(b"\n") == 1
        assert json.loads(payload) == {
            "token": "a" * 32,
            "host": "127.0.0.1",
            "port": 43123,
        }
        assert dialer.writer.drains == 1
        assert dialer.writer.closed is True
        assert dialer.writer.awaited_closed is True
        assert lifecycle == ["start", "ready"]

        os.close(parent_write)
        parent_write = -1
        await asyncio.wait_for(task, timeout=0.2)
        assert lifecycle == ["start", "ready", "stop"]
    finally:
        if parent_write >= 0:
            os.close(parent_write)
        os.close(parent_read)
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_desktop_entry_dials_readiness_endpoint_from_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE", "")
    monkeypatch.setenv("NOVA_AUDIO_AGENT_DESKTOP_READY_ENDPOINT", "127.0.0.1:60001")
    parent_read, parent_write = os.pipe()
    dialer = _ReadyDialer()
    service_stopped = asyncio.Event()

    class _Assembly:
        service = SimpleNamespace(codex_state="idle", wait_stopped=service_stopped.wait)

        async def start(self) -> None:
            return None

        async def stop(self) -> None:
            return None

    class _BoundSocket:
        def getsockname(self) -> tuple[str, int]:
            return ("127.0.0.1", 44444)

    class _Server:
        sockets = [_BoundSocket()]

        async def __aenter__(self) -> _Server:
            return self

        async def __aexit__(self, *args: object) -> None:
            del args

    task = asyncio.create_task(
        _run_desktop(
            token="b" * 32,
            parent_fd=parent_read,
            settings=object(),
            build_assembly=lambda *_args, **_kwargs: _Assembly(),
            serve_websocket=lambda *_args, **_kwargs: _Server(),
            open_ready_connection=dialer,
            install_signal_handlers=False,
        )
    )
    try:
        await asyncio.wait_for(dialer.written.wait(), timeout=0.2)
        assert dialer.targets == [("127.0.0.1", 60001)]
        assert json.loads(dialer.writer.payload()) == {
            "token": "b" * 32,
            "host": "127.0.0.1",
            "port": 44444,
        }
    finally:
        os.close(parent_write)
        os.close(parent_read)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.real_time
@pytest.mark.asyncio
async def test_desktop_entry_dials_a_real_loopback_listener_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The default ``open_ready_connection`` must reach a real loopback listener."""

    monkeypatch.setenv("NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE", "")
    parent_read, parent_write = os.pipe()
    received: asyncio.Queue[bytes] = asyncio.Queue()

    async def on_ready(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await received.put(await reader.readline())
        writer.close()

    listener = await asyncio.start_server(on_ready, "127.0.0.1", 0)
    ready_port = int(listener.sockets[0].getsockname()[1])
    service_stopped = asyncio.Event()

    class _Assembly:
        service = SimpleNamespace(codex_state="idle", wait_stopped=service_stopped.wait)

        async def start(self) -> None:
            return None

        async def stop(self) -> None:
            return None

    class _BoundSocket:
        def getsockname(self) -> tuple[str, int]:
            return ("127.0.0.1", 43123)

    class _Server:
        sockets = [_BoundSocket()]

        async def __aenter__(self) -> _Server:
            return self

        async def __aexit__(self, *args: object) -> None:
            del args

    task = asyncio.create_task(
        _run_desktop(
            token="c" * 32,
            ready_endpoint=f"127.0.0.1:{ready_port}",
            parent_fd=parent_read,
            settings=object(),
            build_assembly=lambda *_args, **_kwargs: _Assembly(),
            serve_websocket=lambda *_args, **_kwargs: _Server(),
            install_signal_handlers=False,
        )
    )
    try:
        line = await asyncio.wait_for(received.get(), timeout=1.0)
        assert json.loads(line) == {
            "token": "c" * 32,
            "host": "127.0.0.1",
            "port": 43123,
        }
    finally:
        os.close(parent_write)
        os.close(parent_read)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        listener.close()
        await listener.wait_closed()


@pytest.mark.asyncio
async def test_desktop_entry_rejects_missing_readiness_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("NOVA_AUDIO_AGENT_DESKTOP_READY_ENDPOINT", raising=False)

    with pytest.raises(ConfigurationError, match="NOVA_AUDIO_AGENT_DESKTOP_READY_ENDPOINT"):
        await _run_desktop(
            token="a" * 32,
            settings=object(),
            build_assembly=lambda *_args, **_kwargs: pytest.fail("assembly was called"),
            serve_websocket=lambda *_args, **_kwargs: None,
            open_ready_connection=lambda *_args: pytest.fail("readiness was dialed"),
            install_signal_handlers=False,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "endpoint",
    [
        "",
        "   ",
        "51515",
        "127.0.0.1",
        "127.0.0.1:",
        "127.0.0.1:abc",
        "127.0.0.1:0",
        "127.0.0.1:65536",
        "127.0.0.1:-1",
        "0.0.0.0:51515",
        "example.com:51515",
    ],
)
async def test_desktop_entry_rejects_malformed_readiness_endpoint(endpoint: str) -> None:
    with pytest.raises(ConfigurationError, match="NOVA_AUDIO_AGENT_DESKTOP_READY_ENDPOINT"):
        await _run_desktop(
            token="a" * 32,
            ready_endpoint=endpoint,
            settings=object(),
            build_assembly=lambda *_args, **_kwargs: pytest.fail("assembly was called"),
            serve_websocket=lambda *_args, **_kwargs: None,
            open_ready_connection=lambda *_args: pytest.fail("readiness was dialed"),
            install_signal_handlers=False,
        )


@pytest.mark.asyncio
async def test_desktop_entry_treats_readiness_dial_failure_as_fatal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE", "")
    parent_read, parent_write = os.pipe()
    lifecycle: list[str] = []

    class _Assembly:
        service = SimpleNamespace(codex_state="idle", wait_stopped=asyncio.Event().wait)

        async def start(self) -> None:
            lifecycle.append("start")

        async def stop(self) -> None:
            lifecycle.append("stop")

    class _BoundSocket:
        def getsockname(self) -> tuple[str, int]:
            return ("127.0.0.1", 43123)

    class _Server:
        sockets = [_BoundSocket()]

        async def __aenter__(self) -> _Server:
            return self

        async def __aexit__(self, *args: object) -> None:
            del args

    async def refuse(host: str, port: int) -> tuple[object, object]:
        del host, port
        raise ConnectionRefusedError("readiness listener is gone")

    try:
        with pytest.raises(ConnectionRefusedError, match="readiness listener is gone"):
            await _run_desktop(
                token="a" * 32,
                ready_endpoint=READY_ENDPOINT,
                parent_fd=parent_read,
                settings=object(),
                build_assembly=lambda *_args, **_kwargs: _Assembly(),
                serve_websocket=lambda *_args, **_kwargs: _Server(),
                open_ready_connection=refuse,
                install_signal_handlers=False,
            )
        assert lifecycle == ["start", "stop"]
    finally:
        os.close(parent_write)
        os.close(parent_read)


@pytest.mark.asyncio
async def test_desktop_entry_treats_readiness_write_failure_as_fatal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE", "")
    parent_read, parent_write = os.pipe()
    lifecycle: list[str] = []
    dialer = _ReadyDialer(drain_error=BrokenPipeError("readiness pipe closed"))

    class _Assembly:
        service = SimpleNamespace(codex_state="idle", wait_stopped=asyncio.Event().wait)

        async def start(self) -> None:
            lifecycle.append("start")

        async def stop(self) -> None:
            lifecycle.append("stop")

    class _BoundSocket:
        def getsockname(self) -> tuple[str, int]:
            return ("127.0.0.1", 43123)

    class _Server:
        sockets = [_BoundSocket()]

        async def __aenter__(self) -> _Server:
            return self

        async def __aexit__(self, *args: object) -> None:
            del args

    try:
        with pytest.raises(BrokenPipeError, match="readiness pipe closed"):
            await _run_desktop(
                token="a" * 32,
                ready_endpoint=READY_ENDPOINT,
                parent_fd=parent_read,
                settings=object(),
                build_assembly=lambda *_args, **_kwargs: _Assembly(),
                serve_websocket=lambda *_args, **_kwargs: _Server(),
                open_ready_connection=dialer,
                install_signal_handlers=False,
            )
        assert lifecycle == ["start", "stop"]
        assert dialer.writer.closed is True
    finally:
        os.close(parent_write)
        os.close(parent_read)


@pytest.mark.asyncio
async def test_desktop_entry_selects_file_camera_from_environment(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    parent_read, parent_write = os.pipe()
    video = tmp_path / "cat-sofa.mp4"
    video.write_bytes(b"video")
    monkeypatch.setenv("NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE", str(video))

    class _StopBeforeStartup(Exception):
        pass

    def build_assembly(_settings: object, **callbacks: Any) -> None:
        assert callbacks["camera_source"] == "file"
        assert callbacks["camera_file"] == video
        raise _StopBeforeStartup

    try:
        with pytest.raises(_StopBeforeStartup):
            await _run_desktop(
                token="a" * 32,
                ready_endpoint=READY_ENDPOINT,
                parent_fd=parent_read,
                settings=object(),
                build_assembly=build_assembly,
                serve_websocket=lambda *_args, **_kwargs: None,
                open_ready_connection=lambda *_args: pytest.fail("readiness was dialed"),
                install_signal_handlers=False,
            )
    finally:
        os.close(parent_write)
        os.close(parent_read)


@pytest.mark.asyncio
async def test_desktop_entry_rejects_relative_video_file_before_assembly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    parent_read, parent_write = os.pipe()
    monkeypatch.setenv("NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE", "relative.mp4")

    try:
        with pytest.raises(ConfigurationError, match="NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE"):
            await _run_desktop(
                token="a" * 32,
                ready_endpoint=READY_ENDPOINT,
                parent_fd=parent_read,
                settings=object(),
                build_assembly=lambda *_args, **_kwargs: pytest.fail("assembly was called"),
                serve_websocket=lambda *_args, **_kwargs: None,
                open_ready_connection=lambda *_args: pytest.fail("readiness was dialed"),
                install_signal_handlers=False,
            )
    finally:
        os.close(parent_write)
        os.close(parent_read)


@pytest.mark.asyncio
async def test_desktop_entry_cleans_assembly_when_start_fails() -> None:
    parent_read, parent_write = os.pipe()
    lifecycle: list[str] = []

    class _Assembly:
        service = SimpleNamespace(codex_state="idle", wait_stopped=asyncio.Event().wait)

        async def start(self) -> None:
            lifecycle.append("start")
            raise RuntimeError("start failed")

        async def stop(self) -> None:
            lifecycle.append("stop")

    class _BoundSocket:
        def getsockname(self) -> tuple[str, int]:
            return ("127.0.0.1", 43123)

    class _Server:
        sockets = [_BoundSocket()]

        async def __aenter__(self) -> _Server:
            return self

        async def __aexit__(self, *args: object) -> None:
            del args

    try:
        with pytest.raises(RuntimeError, match="start failed"):
            await _run_desktop(
                token="a" * 32,
                ready_endpoint=READY_ENDPOINT,
                parent_fd=parent_read,
                settings=object(),
                build_assembly=lambda *_args, **_kwargs: _Assembly(),
                serve_websocket=lambda *_args, **_kwargs: _Server(),
                open_ready_connection=lambda *_args: pytest.fail("readiness was dialed"),
                install_signal_handlers=False,
            )
        assert lifecycle == ["start", "stop"]
    finally:
        os.close(parent_write)
        os.close(parent_read)
