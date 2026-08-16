from __future__ import annotations

import asyncio
import sys
import threading
import traceback
from pathlib import Path

import pytest
from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.events import WakeReason
from nova_audio_agent.executors.camera import (
    CAMERA_MANIFEST,
    CamAdapter,
    DisabledFrameSource,
    Frame,
    OpenCVFrameSource,
    ScriptedFrameSource,
    VideoFileFrameSource,
)
from nova_audio_agent.media import MediaStore
from nova_audio_agent.ports import DelegateRequest, DispatchContext, bind_delegate


class _Encoded:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def tobytes(self) -> bytes:
        return self._payload


class _Capture:
    def __init__(
        self,
        frames: list[str],
        *,
        fps: float = 2.0,
        frame_count: float | None = None,
        opened: bool = True,
    ) -> None:
        self.frames = frames
        self.fps = fps
        self.frame_count = len(frames) if frame_count is None else frame_count
        self.opened = opened
        self.position = 0
        self.reads = 0
        self.releases = 0

    def isOpened(self) -> bool:
        return self.opened

    def get(self, property_id: int) -> float:
        if property_id == _Cv2.CAP_PROP_FPS:
            return self.fps
        if property_id == _Cv2.CAP_PROP_FRAME_COUNT:
            return self.frame_count
        raise AssertionError(f"unexpected property: {property_id}")

    def set(self, property_id: int, value: float) -> bool:
        assert property_id == _Cv2.CAP_PROP_POS_FRAMES
        self.position = int(value)
        return True

    def read(self) -> tuple[bool, str | None]:
        self.reads += 1
        if self.position >= len(self.frames):
            return False, None
        frame = self.frames[self.position]
        self.position += 1
        return True, frame

    def release(self) -> None:
        self.releases += 1


class _Cv2:
    CAP_PROP_FPS = 1
    CAP_PROP_FRAME_COUNT = 2
    CAP_PROP_POS_FRAMES = 3
    IMWRITE_JPEG_QUALITY = 4

    def __init__(self, capture: _Capture) -> None:
        self.capture = capture
        self.paths: list[object] = []

    def VideoCapture(self, path: object) -> _Capture:
        self.paths.append(path)
        return self.capture

    def resize(self, raw: str, size: tuple[int, int]) -> str:
        return raw

    def imencode(self, suffix: str, raw: str, options: list[int]) -> tuple[bool, _Encoded]:
        assert suffix == ".jpg"
        assert options == [self.IMWRITE_JPEG_QUALITY, 80]
        return True, _Encoded(raw.encode())


async def test_video_file_source_rejects_an_unopenable_file_without_exposing_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    cv2 = _Cv2(_Capture([], opened=False))
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    source = VideoFileFrameSource(VirtualClock(), Path("/private/secret-cat.mp4"))

    with pytest.raises(camera.CameraError) as exc_info:
        await source.start()

    assert "/private/secret-cat.mp4" not in str(exc_info.value)
    assert cv2.capture.releases == 1


async def test_video_file_source_converts_open_errors_to_safe_camera_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    cv2 = _Cv2(_Capture([]))

    def _raise_for_path(path: object) -> _Capture:
        raise OSError(f"not a video: {path}")

    monkeypatch.setattr(cv2, "VideoCapture", _raise_for_path)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    source = VideoFileFrameSource(VirtualClock(), Path("/private/secret-cat.mp4"))

    with pytest.raises(camera.CameraError) as exc_info:
        await source.start()

    assert "/private/secret-cat.mp4" not in str(exc_info.value)
    assert "/private/secret-cat.mp4" not in "".join(traceback.format_exception(exc_info.value))


async def test_video_file_source_sanitizes_lazy_import_tracebacks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    def _raise_for_import(name: str):
        raise ModuleNotFoundError("missing backend: /private/secret-cat.mp4")

    monkeypatch.setattr(camera.importlib, "import_module", _raise_for_import)
    source = VideoFileFrameSource(VirtualClock(), Path("cat.mp4"))

    with pytest.raises(camera.CameraError) as exc_info:
        await source.start()

    assert "/private/secret-cat.mp4" not in "".join(traceback.format_exception(exc_info.value))


async def test_video_file_source_rejects_metadata_without_a_positive_frame_count(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["zero"], frame_count=0.5)
    cv2 = _Cv2(capture)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    source = VideoFileFrameSource(VirtualClock(), Path("cat.mp4"))

    with pytest.raises(camera.CameraError):
        await source.start()

    assert capture.releases == 1


async def test_video_file_source_starts_paused_on_the_first_frame(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["first", "second"])
    cv2 = _Cv2(capture)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    source = VideoFileFrameSource(VirtualClock(start=10.0), Path("cat.mp4"))

    await source.start()
    frame = await source.snapshot()

    assert frame == Frame(b"first", "image/jpeg", 1280, 720, 10.0)
    assert capture.reads == 1


async def test_video_file_source_releases_capture_when_open_is_cancelled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["zero"])
    cv2 = _Cv2(capture)
    open_started = threading.Event()
    finish_open = threading.Event()

    def _blocking_open(path: object) -> _Capture:
        open_started.set()
        finish_open.wait()
        return capture

    monkeypatch.setattr(cv2, "VideoCapture", _blocking_open)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    source = VideoFileFrameSource(VirtualClock(), Path("cat.mp4"))

    start = asyncio.create_task(source.start())
    await asyncio.to_thread(open_started.wait)
    start.cancel()
    for _ in range(5):
        await asyncio.sleep(0)
    cancellation_waited_for_open = not start.done()
    finish_open.set()
    with pytest.raises(asyncio.CancelledError):
        await start

    assert cancellation_waited_for_open is True
    assert capture.releases == 1


async def test_video_file_source_releases_capture_when_open_is_cancelled_twice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["zero"])
    cv2 = _Cv2(capture)
    open_started = threading.Event()
    finish_open = threading.Event()

    def _blocking_open(path: object) -> _Capture:
        open_started.set()
        finish_open.wait()
        return capture

    monkeypatch.setattr(cv2, "VideoCapture", _blocking_open)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    source = VideoFileFrameSource(VirtualClock(), Path("cat.mp4"))

    start = asyncio.create_task(source.start())
    await asyncio.to_thread(open_started.wait)
    start.cancel()
    await asyncio.sleep(0)
    start.cancel()
    finish_open.set()
    with pytest.raises(asyncio.CancelledError):
        await start

    assert capture.releases == 1


async def test_video_file_source_sanitizes_cancelled_open_failure_traceback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    cv2 = _Cv2(_Capture(["zero"]))
    open_started = threading.Event()
    finish_open = threading.Event()

    def _failing_open(path: object) -> _Capture:
        open_started.set()
        finish_open.wait()
        raise OSError(f"cannot open {path}")

    monkeypatch.setattr(cv2, "VideoCapture", _failing_open)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    source = VideoFileFrameSource(VirtualClock(), Path("/private/secret-cat.mp4"))

    start = asyncio.create_task(source.start())
    await asyncio.to_thread(open_started.wait)
    start.cancel()
    finish_open.set()
    with pytest.raises(asyncio.CancelledError) as exc_info:
        await start

    assert "/private/secret-cat.mp4" not in "".join(traceback.format_exception(exc_info.value))


async def test_video_file_source_releases_capture_when_metadata_is_cancelled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["zero"])
    cv2 = _Cv2(capture)
    metadata_started = threading.Event()
    metadata_finished = threading.Event()
    finish_metadata = threading.Event()
    original_get = capture.get
    original_release = capture.release

    def _blocking_get(property_id: int) -> float:
        if property_id == cv2.CAP_PROP_FPS:
            metadata_started.set()
            finish_metadata.wait()
            metadata_finished.set()
        return original_get(property_id)

    def _release_after_metadata() -> None:
        assert metadata_finished.is_set()
        original_release()

    monkeypatch.setattr(capture, "get", _blocking_get)
    monkeypatch.setattr(capture, "release", _release_after_metadata)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    source = VideoFileFrameSource(VirtualClock(), Path("cat.mp4"))

    start = asyncio.create_task(source.start())
    await asyncio.to_thread(metadata_started.wait)
    start.cancel()
    for _ in range(5):
        await asyncio.sleep(0)
    cancellation_waited_for_metadata = not start.done()
    finish_metadata.set()
    with pytest.raises(asyncio.CancelledError):
        await start

    assert cancellation_waited_for_metadata is True
    assert capture.releases == 1


async def test_video_file_source_waits_when_metadata_is_cancelled_twice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["zero"])
    cv2 = _Cv2(capture)
    metadata_started = threading.Event()
    metadata_finished = threading.Event()
    finish_metadata = threading.Event()
    original_get = capture.get
    original_release = capture.release

    def _blocking_get(property_id: int) -> float:
        if property_id == cv2.CAP_PROP_FPS:
            metadata_started.set()
            finish_metadata.wait()
            metadata_finished.set()
        return original_get(property_id)

    def _release_after_metadata() -> None:
        assert metadata_finished.is_set()
        original_release()

    monkeypatch.setattr(capture, "get", _blocking_get)
    monkeypatch.setattr(capture, "release", _release_after_metadata)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    source = VideoFileFrameSource(VirtualClock(), Path("cat.mp4"))

    start = asyncio.create_task(source.start())
    await asyncio.to_thread(metadata_started.wait)
    start.cancel()
    await asyncio.sleep(0)
    start.cancel()
    for _ in range(5):
        await asyncio.sleep(0)
    cancellation_waited_for_metadata = not start.done()
    finish_metadata.set()
    with pytest.raises(asyncio.CancelledError):
        await start

    assert cancellation_waited_for_metadata is True
    assert capture.releases == 1


async def test_video_file_source_releases_capture_when_first_read_is_cancelled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["zero"])
    cv2 = _Cv2(capture)
    read_started = asyncio.Event()
    finish_read = asyncio.Event()

    async def _controlled_to_thread(func, *args):
        if getattr(func, "__self__", None) is capture and func.__name__ == "read":
            read_started.set()
            await finish_read.wait()
        return func(*args)

    monkeypatch.setattr(camera.asyncio, "to_thread", _controlled_to_thread)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    source = VideoFileFrameSource(VirtualClock(), Path("cat.mp4"))

    start = asyncio.create_task(source.start())
    await read_started.wait()
    start.cancel()
    for _ in range(5):
        await asyncio.sleep(0)
    cancellation_waited_for_read = not start.done()
    finish_read.set()
    with pytest.raises(asyncio.CancelledError):
        await start

    assert cancellation_waited_for_read is True
    assert capture.releases == 1


async def test_video_file_source_advances_by_elapsed_clock_time(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["zero", "one", "two", "three"], fps=2.0)
    cv2 = _Cv2(capture)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    clock = VirtualClock(start=10.0)
    source = VideoFileFrameSource(clock, Path("cat.mp4"))

    await source.start()
    await source.restart()
    clock.advance_to(11.1)
    frame = await source.snapshot()

    assert frame == Frame(b"two", "image/jpeg", 1280, 720, 11.1)


async def test_video_file_source_commits_cancelled_sequential_read_before_unlocking(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["zero", "one", "two"], fps=2.0)
    cv2 = _Cv2(capture)
    playback_read_finished = asyncio.Event()
    release_playback_read = asyncio.Event()
    reads = 0

    async def _controlled_to_thread(func, *args):
        nonlocal reads
        result = func(*args)
        if getattr(func, "__self__", None) is capture and func.__name__ == "read":
            reads += 1
            if reads == 3:
                playback_read_finished.set()
                await release_playback_read.wait()
        return result

    monkeypatch.setattr(camera.asyncio, "to_thread", _controlled_to_thread)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    clock = VirtualClock()
    source = VideoFileFrameSource(clock, Path("cat.mp4"))
    await source.start()
    await source.restart()
    clock.advance_to(0.5)

    cancelled_snapshot = asyncio.create_task(source.snapshot())
    await playback_read_finished.wait()
    cancelled_snapshot.cancel()
    release_playback_read.set()
    with pytest.raises(asyncio.CancelledError):
        await cancelled_snapshot

    next_frame = await source.snapshot()

    assert next_frame == Frame(b"one", "image/jpeg", 1280, 720, 0.5)


async def test_video_file_source_commits_cancelled_multi_read_advance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["zero", "one", "two"], fps=2.0)
    cv2 = _Cv2(capture)
    second_playback_read_finished = asyncio.Event()
    release_second_playback_read = asyncio.Event()
    reads = 0

    async def _controlled_to_thread(func, *args):
        nonlocal reads
        result = func(*args)
        if getattr(func, "__self__", None) is capture and func.__name__ == "read":
            reads += 1
            if reads == 4:
                second_playback_read_finished.set()
                await release_second_playback_read.wait()
        return result

    monkeypatch.setattr(camera.asyncio, "to_thread", _controlled_to_thread)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    clock = VirtualClock()
    source = VideoFileFrameSource(clock, Path("cat.mp4"))
    await source.start()
    await source.restart()
    clock.advance_to(1.0)

    cancelled_snapshot = asyncio.create_task(source.snapshot())
    await second_playback_read_finished.wait()
    cancelled_snapshot.cancel()
    release_second_playback_read.set()
    with pytest.raises(asyncio.CancelledError):
        await cancelled_snapshot

    next_frame = await source.snapshot()

    assert next_frame == Frame(b"two", "image/jpeg", 1280, 720, 1.0)


async def test_video_file_source_commits_double_cancelled_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["zero", "one", "two"], fps=2.0)
    cv2 = _Cv2(capture)
    playback_read_finished = asyncio.Event()
    release_playback_read = asyncio.Event()
    reads = 0

    async def _controlled_to_thread(func, *args):
        nonlocal reads
        result = func(*args)
        if getattr(func, "__self__", None) is capture and func.__name__ == "read":
            reads += 1
            if reads == 3:
                playback_read_finished.set()
                await release_playback_read.wait()
        return result

    monkeypatch.setattr(camera.asyncio, "to_thread", _controlled_to_thread)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    clock = VirtualClock()
    source = VideoFileFrameSource(clock, Path("cat.mp4"))
    await source.start()
    await source.restart()
    clock.advance_to(0.5)

    cancelled_snapshot = asyncio.create_task(source.snapshot())
    await playback_read_finished.wait()
    cancelled_snapshot.cancel()
    await asyncio.sleep(0)
    cancelled_snapshot.cancel()
    release_playback_read.set()
    with pytest.raises(asyncio.CancelledError):
        await cancelled_snapshot

    next_frame = await source.snapshot()

    assert next_frame == Frame(b"one", "image/jpeg", 1280, 720, 0.5)


async def test_video_file_source_serializes_concurrent_snapshots(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["zero", "one", "two"], fps=2.0)
    cv2 = _Cv2(capture)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    real_to_thread = camera.asyncio.to_thread
    first_read_started = asyncio.Event()
    release_first_read = asyncio.Event()
    playback_reads = 0

    async def _controlled_to_thread(func, *args):
        nonlocal playback_reads
        result = func(*args)
        if getattr(func, "__self__", None) is capture and func.__name__ == "read":
            playback_reads += 1
            if playback_reads == 3:
                first_read_started.set()
                await release_first_read.wait()
        return result

    monkeypatch.setattr(camera.asyncio, "to_thread", _controlled_to_thread)
    clock = VirtualClock(start=10.0)
    source = VideoFileFrameSource(clock, Path("cat.mp4"))
    await source.start()
    await source.restart()
    clock.advance_to(11.1)

    first = asyncio.create_task(source.snapshot())
    await first_read_started.wait()
    second = asyncio.create_task(source.snapshot())
    await asyncio.sleep(0)
    release_first_read.set()
    frames = await asyncio.gather(first, second)
    monkeypatch.setattr(camera.asyncio, "to_thread", real_to_thread)

    assert [frame.payload for frame in frames if frame is not None] == [b"two", b"two"]


async def test_video_file_source_serializes_snapshot_and_restart(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["zero", "one", "two"], fps=2.0)
    cv2 = _Cv2(capture)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    first_read_started = asyncio.Event()
    release_first_read = asyncio.Event()
    playback_reads = 0

    async def _controlled_to_thread(func, *args):
        nonlocal playback_reads
        result = func(*args)
        if getattr(func, "__self__", None) is capture and func.__name__ == "read":
            playback_reads += 1
            if playback_reads == 3:
                first_read_started.set()
                await release_first_read.wait()
        return result

    monkeypatch.setattr(camera.asyncio, "to_thread", _controlled_to_thread)
    clock = VirtualClock(start=10.0)
    source = VideoFileFrameSource(clock, Path("cat.mp4"))
    await source.start()
    await source.restart()
    clock.advance_to(11.1)

    snapshot = asyncio.create_task(source.snapshot())
    await first_read_started.wait()
    restart = asyncio.create_task(source.restart())
    await asyncio.sleep(0)
    release_first_read.set()
    frame, _ = await asyncio.gather(snapshot, restart)
    restarted_frame = await source.snapshot()

    assert frame == Frame(b"two", "image/jpeg", 1280, 720, 11.1)
    assert restarted_frame == Frame(b"zero", "image/jpeg", 1280, 720, 11.1)


async def test_video_file_source_commits_cancelled_restart_after_seek(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["zero", "one", "two"], fps=2.0)
    cv2 = _Cv2(capture)
    cancelled_seek_finished = asyncio.Event()
    release_cancelled_seek = asyncio.Event()
    seeks = 0

    async def _controlled_to_thread(func, *args):
        nonlocal seeks
        result = func(*args)
        if getattr(func, "__self__", None) is capture and func.__name__ == "set":
            seeks += 1
            if seeks == 2:
                cancelled_seek_finished.set()
                await release_cancelled_seek.wait()
        return result

    monkeypatch.setattr(camera.asyncio, "to_thread", _controlled_to_thread)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    clock = VirtualClock()
    source = VideoFileFrameSource(clock, Path("cat.mp4"))
    await source.start()
    await source.restart()
    clock.advance_to(1.0)
    advanced = await source.snapshot()
    assert advanced is not None
    assert advanced.payload == b"two"

    cancelled_restart = asyncio.create_task(source.restart())
    await cancelled_seek_finished.wait()
    cancelled_restart.cancel()
    release_cancelled_seek.set()
    with pytest.raises(asyncio.CancelledError):
        await cancelled_restart

    next_frame = await source.snapshot()

    assert next_frame == Frame(b"zero", "image/jpeg", 1280, 720, 1.0)


async def test_video_file_source_commits_cancelled_restart_after_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["zero", "one", "two"], fps=2.0)
    cv2 = _Cv2(capture)
    cancelled_read_finished = asyncio.Event()
    release_cancelled_read = asyncio.Event()
    reads = 0

    async def _controlled_to_thread(func, *args):
        nonlocal reads
        result = func(*args)
        if getattr(func, "__self__", None) is capture and func.__name__ == "read":
            reads += 1
            if reads == 5:
                cancelled_read_finished.set()
                await release_cancelled_read.wait()
        return result

    monkeypatch.setattr(camera.asyncio, "to_thread", _controlled_to_thread)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    clock = VirtualClock()
    source = VideoFileFrameSource(clock, Path("cat.mp4"))
    await source.start()
    await source.restart()
    clock.advance_to(1.0)
    advanced = await source.snapshot()
    assert advanced is not None
    assert advanced.payload == b"two"

    cancelled_restart = asyncio.create_task(source.restart())
    await cancelled_read_finished.wait()
    cancelled_restart.cancel()
    release_cancelled_read.set()
    with pytest.raises(asyncio.CancelledError):
        await cancelled_restart

    next_frame = await source.snapshot()

    assert next_frame == Frame(b"zero", "image/jpeg", 1280, 720, 1.0)


async def test_video_file_source_commits_double_cancelled_restart(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["zero", "one", "two"], fps=2.0)
    cv2 = _Cv2(capture)
    restart_read_finished = asyncio.Event()
    release_restart_read = asyncio.Event()
    reads = 0

    async def _controlled_to_thread(func, *args):
        nonlocal reads
        result = func(*args)
        if getattr(func, "__self__", None) is capture and func.__name__ == "read":
            reads += 1
            if reads == 5:
                restart_read_finished.set()
                await release_restart_read.wait()
        return result

    monkeypatch.setattr(camera.asyncio, "to_thread", _controlled_to_thread)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    clock = VirtualClock()
    source = VideoFileFrameSource(clock, Path("cat.mp4"))
    await source.start()
    await source.restart()
    clock.advance_to(1.0)
    advanced = await source.snapshot()
    assert advanced is not None
    assert advanced.payload == b"two"

    cancelled_restart = asyncio.create_task(source.restart())
    await restart_read_finished.wait()
    cancelled_restart.cancel()
    await asyncio.sleep(0)
    cancelled_restart.cancel()
    release_restart_read.set()
    with pytest.raises(asyncio.CancelledError):
        await cancelled_restart

    next_frame = await source.snapshot()

    assert next_frame == Frame(b"zero", "image/jpeg", 1280, 720, 1.0)


async def test_video_file_source_converts_restart_seek_errors_to_camera_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["zero"])
    cv2 = _Cv2(capture)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    source = VideoFileFrameSource(VirtualClock(), Path("cat.mp4"))
    await source.start()

    def _raise_for_seek(property_id: int, value: float) -> bool:
        raise OSError("capture unavailable: /private/secret-cat.mp4")

    monkeypatch.setattr(capture, "set", _raise_for_seek)
    with pytest.raises(camera.CameraError) as exc_info:
        await source.restart()

    assert "/private/secret-cat.mp4" not in "".join(traceback.format_exception(exc_info.value))


async def test_video_file_source_sanitizes_sequential_read_tracebacks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["zero", "one"])
    cv2 = _Cv2(capture)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    clock = VirtualClock()
    source = VideoFileFrameSource(clock, Path("cat.mp4"))
    await source.start()
    await source.restart()
    clock.advance_to(0.5)

    def _raise_for_read():
        raise OSError("read failed: /private/secret-cat.mp4")

    monkeypatch.setattr(capture, "read", _raise_for_read)
    with pytest.raises(camera.CameraError) as exc_info:
        await source.snapshot()

    assert "/private/secret-cat.mp4" not in "".join(traceback.format_exception(exc_info.value))


async def test_video_file_source_sanitizes_encode_tracebacks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["zero"])
    cv2 = _Cv2(capture)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    source = VideoFileFrameSource(VirtualClock(), Path("cat.mp4"))
    await source.start()

    def _raise_for_resize(raw: str, size: tuple[int, int]) -> str:
        raise OSError("encode failed: /private/secret-cat.mp4")

    monkeypatch.setattr(cv2, "resize", _raise_for_resize)
    with pytest.raises(camera.CameraError) as exc_info:
        await source.snapshot()

    assert "/private/secret-cat.mp4" not in "".join(traceback.format_exception(exc_info.value))


async def test_video_file_source_holds_the_last_decoded_frame_at_eof(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["zero", "one"], fps=2.0, frame_count=3)
    cv2 = _Cv2(capture)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    clock = VirtualClock()
    source = VideoFileFrameSource(clock, Path("cat.mp4"))

    await source.start()
    await source.restart()
    clock.advance_to(1.0)
    frame = await source.snapshot()

    assert frame == Frame(b"one", "image/jpeg", 1280, 720, 1.0)


async def test_video_file_source_lifecycle_is_idempotent_and_releases_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["zero"])
    cv2 = _Cv2(capture)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    source = VideoFileFrameSource(VirtualClock(), Path("cat.mp4"))

    await source.start()
    await source.start()
    await source.stop()
    await source.stop()

    assert cv2.paths == ["cat.mp4"]
    assert capture.releases == 1


async def test_video_file_source_sanitizes_release_tracebacks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import nova_audio_agent.executors.camera as camera

    capture = _Capture(["zero"])
    cv2 = _Cv2(capture)
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: cv2)
    source = VideoFileFrameSource(VirtualClock(), Path("cat.mp4"))
    await source.start()

    def _raise_for_release() -> None:
        raise OSError("release failed: /private/secret-cat.mp4")

    monkeypatch.setattr(capture, "release", _raise_for_release)
    with pytest.raises(camera.CameraError) as exc_info:
        await source.stop()

    assert "/private/secret-cat.mp4" not in "".join(traceback.format_exception(exc_info.value))


def _ctx() -> DispatchContext:
    op = CAMERA_MANIFEST.op("snapshot")
    assert op is not None
    clock = VirtualClock()
    delegate = bind_delegate(
        DelegateRequest(
            executor="cam",
            op="snapshot",
            request={},
            origin_ref="conversation:1",
        ),
        wake_reason=WakeReason(
            kind="user_input",
            priority=100,
            routing_class="user_awaited",
        ),
        op=op,
        now=clock.now(),
        delegate_id="d-cam-1",
    )
    return DispatchContext(clock=clock, delegate=delegate)


def test_importing_camera_executor_does_not_import_opencv() -> None:
    assert "cv2" not in sys.modules


async def test_scripted_and_disabled_sources_have_explicit_lifecycles() -> None:
    frame = Frame(
        payload=b"jpeg",
        media_type="image/jpeg",
        width=1280,
        height=720,
        captured_at=4.0,
    )
    scripted = ScriptedFrameSource(frame)
    disabled = DisabledFrameSource()

    await scripted.start()
    await disabled.start()
    assert await scripted.snapshot() == frame
    assert await disabled.snapshot() is None
    await scripted.stop()
    await disabled.stop()

    assert scripted.starts == 1
    assert scripted.stops == 1


async def test_cam_snapshot_puts_the_latest_frame_in_store_as_external_evidence() -> None:
    frame = Frame(
        payload=b"jpeg",
        media_type="image/jpeg",
        width=1280,
        height=720,
        captured_at=4.5,
    )
    store = MediaStore(id_factory=lambda: "frame")
    adapter = CamAdapter(ScriptedFrameSource(frame), store)

    handoff = await adapter.dispatch("snapshot", {}, _ctx())

    assert handoff.outcome == "ok"
    assert handoff.trust == "untrusted_external"
    assert handoff.content == {
        "media_ref": "media:frame",
        "digest": "41e5787e9f28562d07b891b1816b492309d646c0f2829743fa4963a9f9cc1d61",
        "media_type": "image/jpeg",
        "width": 1280,
        "height": 720,
        "captured_at": 4.5,
    }
    assert store.peek("media:frame") is not None


async def test_cam_snapshot_awaits_an_on_demand_frame_source() -> None:
    frame = Frame(
        payload=b"on-demand-jpeg",
        media_type="image/jpeg",
        width=640,
        height=480,
        captured_at=8.0,
    )

    class _OnDemandSource:
        async def start(self) -> None:
            return None

        async def stop(self) -> None:
            return None

        async def snapshot(self) -> Frame | None:
            return frame

    adapter = CamAdapter(_OnDemandSource(), MediaStore(id_factory=lambda: "camera"))

    handoff = await adapter.dispatch("snapshot", {}, _ctx())

    assert handoff.outcome == "ok"
    assert handoff.content["media_ref"] == "media:camera"
    assert handoff.content["captured_at"] == 8.0


async def test_cam_snapshot_without_a_frame_is_unknown_not_failed() -> None:
    adapter = CamAdapter(DisabledFrameSource(), MediaStore())

    handoff = await adapter.dispatch("snapshot", {}, _ctx())

    assert handoff.outcome == "unknown"
    assert handoff.trust == "untrusted_external"
    assert handoff.content == {
        "error": "capture_unavailable",
        "op": "snapshot",
        # The probe is declared conclusive for `snapshot`, which is right while the source
        # is alive and wrong for this cause. R49's fence blocks a resend only once, by
        # design, so the observation has to carry the reason a recheck cannot help.
        "recheck": "not_useful_until_capture_recovers",
    }


async def test_cam_unexpected_store_exception_is_a_typed_unknown() -> None:
    class _BrokenStore:
        def put(self, *args, **kwargs):
            del args, kwargs
            raise RuntimeError("private implementation detail")

    frame = Frame(
        payload=b"jpeg",
        media_type="image/jpeg",
        width=1280,
        height=720,
        captured_at=4.5,
    )
    adapter = CamAdapter(ScriptedFrameSource(frame), _BrokenStore())  # type: ignore[arg-type]

    handoff = await adapter.dispatch("snapshot", {}, _ctx())

    assert handoff.outcome == "unknown"
    assert handoff.trust == "untrusted_external"
    assert handoff.content == {"error": "adapter_exception", "op": "snapshot"}


async def test_cam_unknown_op_is_a_typed_failure() -> None:
    adapter = CamAdapter(DisabledFrameSource(), MediaStore())

    handoff = await adapter.dispatch("not-real", {}, _ctx())

    assert handoff.outcome == "failed"
    assert handoff.trust == "untrusted_external"
    assert handoff.content == {"error": "unknown_op", "op": "not-real"}


def test_cam_manifest_is_readonly_and_fast() -> None:
    (snapshot,) = CAMERA_MANIFEST.ops
    assert snapshot.readonly is True
    assert snapshot.deadline_budget == 7.0
    assert snapshot.verifies == ("snapshot",)
    assert CAMERA_MANIFEST.policy.channel == "cam"
    assert CAMERA_MANIFEST.policy.wake == "surrogate"
    assert CAMERA_MANIFEST.policy.typical_latency == 0.05


async def test_opencv_source_captures_latest_jpeg_and_releases_the_device() -> None:
    class _Clock:
        def __init__(self) -> None:
            import asyncio

            self.slept = asyncio.Event()

        def now(self) -> float:
            return 7.5

        async def sleep(self, duration: float) -> None:
            assert duration == 1.0
            self.slept.set()
            await __import__("asyncio").Event().wait()

    class _Encoded:
        def tobytes(self) -> bytes:
            return b"jpeg-frame"

    class _Capture:
        def __init__(self) -> None:
            self.released = False
            self.settings: list[tuple[int, int]] = []

        def isOpened(self) -> bool:
            return True

        def set(self, key: int, value: int) -> None:
            self.settings.append((key, value))

        def read(self):
            return True, "raw-frame"

        def release(self) -> None:
            self.released = True

    class _Cv2:
        CAP_PROP_BUFFERSIZE = 1
        CAP_PROP_FRAME_WIDTH = 2
        CAP_PROP_FRAME_HEIGHT = 3
        IMWRITE_JPEG_QUALITY = 4

        def __init__(self) -> None:
            self.capture = _Capture()
            self.resize_args = None
            self.encode_args = None

        def VideoCapture(self, index: int):
            assert index == 2
            return self.capture

        def resize(self, frame, size):
            self.resize_args = (frame, size)
            return "resized"

        def imencode(self, suffix, frame, options):
            self.encode_args = (suffix, frame, options)
            return True, _Encoded()

    clock = _Clock()
    cv2 = _Cv2()
    source = OpenCVFrameSource(clock=clock, camera_index=2, cv2_module=cv2)

    await source.start()
    await clock.slept.wait()
    frame = await source.snapshot()
    await source.stop()

    assert frame == Frame(
        payload=b"jpeg-frame",
        media_type="image/jpeg",
        width=1280,
        height=720,
        captured_at=7.5,
    )
    assert cv2.resize_args == ("raw-frame", (1280, 720))
    assert cv2.encode_args == (".jpg", "resized", [4, 80])
    assert cv2.capture.released is True
