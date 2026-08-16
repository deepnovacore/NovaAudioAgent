from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from nova_audio_agent.config import ConfigurationError
from nova_audio_agent.realtime.desktop import _run_desktop
from nova_audio_agent.tool_schema import CompiledTools


@pytest.mark.asyncio
async def test_desktop_entry_reports_readiness_and_stops_on_parent_eof(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE", "")
    parent_read, parent_write = os.pipe()
    ready_read, ready_write = os.pipe()
    lifecycle: list[str] = []
    service_stopped = asyncio.Event()

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
        assert callbacks["provider_tool_view"] is None
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
            ready_fd=ready_write,
            parent_fd=parent_read,
            settings=object(),
            build_assembly=build_assembly,
            serve_websocket=serve_websocket,
            install_signal_handlers=False,
        )
    )
    try:
        raw = await asyncio.wait_for(asyncio.to_thread(os.read, ready_read, 4096), timeout=0.2)
        assert json.loads(raw) == {"host": "127.0.0.1", "port": 43123}

        os.close(parent_write)
        parent_write = -1
        await asyncio.wait_for(task, timeout=0.2)
        assert lifecycle == ["start", "stop"]
    finally:
        if parent_write >= 0:
            os.close(parent_write)
        os.close(parent_read)
        os.close(ready_read)
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_desktop_entry_selects_file_camera_from_environment(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    parent_read, parent_write = os.pipe()
    ready_read, ready_write = os.pipe()
    video = tmp_path / "cat-sofa.mp4"
    video.write_bytes(b"video")
    monkeypatch.setenv("NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE", str(video))

    class _StopBeforeStartup(Exception):
        pass

    def build_assembly(_settings: object, **callbacks: Any) -> None:
        assert callbacks["camera_source"] == "file"
        assert callbacks["camera_file"] == video
        provider_tool_view = callbacks["provider_tool_view"]
        assert callable(provider_tool_view)
        bindings: dict[str, object] = {}
        tools = CompiledTools(
            schemas=(
                {"type": "function", "function": {"name": "watch__start"}},
                {"type": "function", "function": {"name": "guard__start"}},
                {"type": "function", "function": {"name": "cam__snapshot"}},
            ),
            bindings=bindings,  # type: ignore[arg-type]
        )

        provider_tools = provider_tool_view(tools)

        assert [schema["function"]["name"] for schema in provider_tools.schemas] == [
            "guard__start",
            "cam__snapshot",
        ]
        assert provider_tools.bindings is bindings
        raise _StopBeforeStartup

    try:
        with pytest.raises(_StopBeforeStartup):
            await _run_desktop(
                token="a" * 32,
                ready_fd=ready_write,
                parent_fd=parent_read,
                settings=object(),
                build_assembly=build_assembly,
                serve_websocket=lambda *_args, **_kwargs: None,
                install_signal_handlers=False,
            )
    finally:
        os.close(parent_write)
        os.close(parent_read)
        os.close(ready_read)
        os.close(ready_write)


@pytest.mark.asyncio
async def test_desktop_entry_rejects_relative_video_file_before_assembly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    parent_read, parent_write = os.pipe()
    ready_read, ready_write = os.pipe()
    monkeypatch.setenv("NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE", "relative.mp4")

    try:
        with pytest.raises(ConfigurationError, match="NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE"):
            await _run_desktop(
                token="a" * 32,
                ready_fd=ready_write,
                parent_fd=parent_read,
                settings=object(),
                build_assembly=lambda *_args, **_kwargs: pytest.fail("assembly was called"),
                serve_websocket=lambda *_args, **_kwargs: None,
                install_signal_handlers=False,
            )
    finally:
        os.close(parent_write)
        os.close(parent_read)
        os.close(ready_read)
        os.close(ready_write)


@pytest.mark.asyncio
async def test_desktop_entry_cleans_assembly_when_start_fails() -> None:
    parent_read, parent_write = os.pipe()
    ready_read, ready_write = os.pipe()
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
                ready_fd=ready_write,
                parent_fd=parent_read,
                settings=object(),
                build_assembly=lambda *_args, **_kwargs: _Assembly(),
                serve_websocket=lambda *_args, **_kwargs: _Server(),
                install_signal_handlers=False,
            )
        assert lifecycle == ["start", "stop"]
    finally:
        os.close(parent_write)
        os.close(parent_read)
        os.close(ready_read)
        os.close(ready_write)
