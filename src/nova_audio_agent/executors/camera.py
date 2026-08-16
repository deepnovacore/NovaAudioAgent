"""Pull-shaped camera executor and frame-source boundary for Stage E."""

from __future__ import annotations

import asyncio
import contextlib
import importlib
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from nova_audio_agent.clock import Clock
from nova_audio_agent.memory import HandoffPolicy
from nova_audio_agent.media import MediaStore
from nova_audio_agent.ports import DispatchContext, ExecutorManifest, Handoff, OpSpec

SNAPSHOT = OpSpec(
    name="snapshot",
    description="查看当前摄像头画面，返回带观察时间的图片引用",
    params={
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": False,
    },
    readonly=True,
    deadline_budget=7.0,
    verifies=("snapshot",),
)

CAMERA_POLICY = HandoffPolicy(
    channel="cam",
    priority=40,
    wake="surrogate",
    typical_latency=0.05,
    compress_watermark=20,
)

CAMERA_MANIFEST = ExecutorManifest(
    name="cam",
    ops=(SNAPSHOT,),
    policy=CAMERA_POLICY,
)


@dataclass(frozen=True, slots=True)
class Frame:
    payload: bytes
    media_type: str
    width: int
    height: int
    captured_at: float


class FrameSource(Protocol):
    async def start(self) -> None: ...

    async def stop(self) -> None: ...

    async def snapshot(self) -> Frame | None: ...


class CameraError(RuntimeError):
    """A credential-free local capture failure."""


class DisabledFrameSource:
    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None

    async def snapshot(self) -> Frame | None:
        return None


class ScriptedFrameSource:
    def __init__(self, frame: Frame | None = None) -> None:
        self.frame = frame
        self.starts = 0
        self.stops = 0

    async def start(self) -> None:
        self.starts += 1

    async def stop(self) -> None:
        self.stops += 1

    async def snapshot(self) -> Frame | None:
        return self.frame


class OpenCVFrameSource:
    def __init__(
        self,
        *,
        clock: Clock,
        camera_index: int = 0,
        width: int = 1280,
        height: int = 720,
        fps: float = 1.0,
        jpeg_quality: int = 80,
        cv2_module: Any = None,
    ) -> None:
        self._clock = clock
        self._camera_index = camera_index
        self._width = width
        self._height = height
        self._interval = 1.0 / fps
        self._jpeg_quality = jpeg_quality
        self._cv2 = cv2_module
        self._capture: Any = None
        self._latest: Frame | None = None
        self._stop_event: asyncio.Event | None = None
        self._task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if self._task is not None:
            return
        if self._cv2 is None:
            try:
                self._cv2 = importlib.import_module("cv2")
            except ModuleNotFoundError as exc:
                raise CameraError("真实摄像头需要 vision extra：uv sync --extra vision") from exc
        capture = await asyncio.to_thread(self._cv2.VideoCapture, self._camera_index)
        if not capture.isOpened():
            capture.release()
            raise CameraError("无法打开摄像头；请检查设备和系统权限")
        for property_name, value in (
            ("CAP_PROP_BUFFERSIZE", 1),
            ("CAP_PROP_FRAME_WIDTH", self._width),
            ("CAP_PROP_FRAME_HEIGHT", self._height),
        ):
            property_id = getattr(self._cv2, property_name, None)
            if property_id is not None:
                with contextlib.suppress(Exception):
                    capture.set(property_id, value)
        self._capture = capture
        self._stop_event = asyncio.Event()
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        task = self._task
        if task is None:
            return
        assert self._stop_event is not None
        self._stop_event.set()
        try:
            await task
        finally:
            self._task = None
            self._stop_event = None
            self._capture = None

    async def snapshot(self) -> Frame | None:
        return self._latest

    async def _run(self) -> None:
        assert self._capture is not None
        assert self._stop_event is not None
        failures = 0
        try:
            while not self._stop_event.is_set():
                try:
                    ok, raw = await asyncio.to_thread(self._capture.read)
                    if not ok:
                        failures += 1
                    else:
                        payload = await asyncio.to_thread(self._encode, raw)
                        self._latest = Frame(
                            payload=payload,
                            media_type="image/jpeg",
                            width=self._width,
                            height=self._height,
                            captured_at=self._clock.now(),
                        )
                        failures = 0
                except asyncio.CancelledError:
                    raise
                except Exception:
                    failures += 1
                if failures >= 10:
                    return
                await self._pause_or_stop()
        finally:
            await asyncio.to_thread(self._capture.release)

    def _encode(self, raw: Any) -> bytes:
        resized = self._cv2.resize(raw, (self._width, self._height))
        ok, encoded = self._cv2.imencode(
            ".jpg",
            resized,
            [int(self._cv2.IMWRITE_JPEG_QUALITY), self._jpeg_quality],
        )
        if not ok:
            raise CameraError("摄像头帧 JPEG 编码失败")
        return encoded.tobytes()

    async def _pause_or_stop(self) -> None:
        assert self._stop_event is not None
        sleep_task = asyncio.create_task(self._clock.sleep(self._interval))
        stop_task = asyncio.create_task(self._stop_event.wait())
        _, pending = await asyncio.wait(
            (sleep_task, stop_task),
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        for task in pending:
            with contextlib.suppress(asyncio.CancelledError):
                await task


class VideoFileFrameSource:
    def __init__(
        self,
        clock: Clock,
        path: Path,
        width: int = 1280,
        height: int = 720,
        jpeg_quality: int = 80,
    ) -> None:
        self._clock = clock
        self._path = path
        self._width = width
        self._height = height
        self._jpeg_quality = jpeg_quality
        self._cv2: Any = None
        self._capture: Any = None
        self._fps: float | None = None
        self._frame_count: int | None = None
        self._latest_raw: Any = None
        self._current_index: int | None = None
        self._epoch: float | None = None
        self._at_eof = False
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        async with self._lock:
            await self._start()

    async def _start(self) -> None:
        if self._capture is not None:
            return
        if self._cv2 is None:
            try:
                self._cv2 = importlib.import_module("cv2")
            except ModuleNotFoundError:
                raise CameraError("视频回放需要 vision extra：uv sync --extra vision") from None
        capture: Any = None
        try:
            capture = await self._open_capture()
            if not capture.isOpened():
                raise CameraError("无法打开视频文件")
            fps = await self._run_in_thread(capture.get, self._cv2.CAP_PROP_FPS)
            frame_count = await self._run_in_thread(capture.get, self._cv2.CAP_PROP_FRAME_COUNT)
            frame_count_int = int(frame_count)
            if (
                not math.isfinite(fps)
                or fps <= 0
                or not math.isfinite(frame_count)
                or frame_count_int <= 0
            ):
                raise CameraError("视频文件元数据无效")
            ok, raw = await self._run_in_thread(capture.read)
            if not ok:
                raise CameraError("无法读取视频首帧")
        except asyncio.CancelledError:
            if capture is not None:
                with contextlib.suppress(Exception):
                    await self._run_in_thread(capture.release)
            raise
        except Exception as exc:
            if capture is not None:
                with contextlib.suppress(Exception):
                    await self._run_in_thread(capture.release)
            if isinstance(exc, CameraError):
                raise
            raise CameraError("无法打开或读取视频文件") from None
        self._capture = capture
        self._fps = fps
        self._frame_count = frame_count_int
        self._latest_raw = raw
        self._current_index = 0
        self._epoch = None
        self._at_eof = False

    async def _open_capture(self) -> Any:
        open_task = asyncio.create_task(asyncio.to_thread(self._cv2.VideoCapture, str(self._path)))
        capture, cancellation = await self._complete_despite_cancellation(open_task)
        if cancellation is None:
            return capture
        if capture is not None:
            with contextlib.suppress(Exception):
                await self._run_in_thread(capture.release)
        raise cancellation

    async def _run_in_thread(self, func: Any, *args: Any) -> Any:
        operation = asyncio.create_task(asyncio.to_thread(func, *args))
        result, cancellation = await self._complete_despite_cancellation(operation)
        if cancellation is not None:
            raise cancellation
        return result

    async def snapshot(self) -> Frame | None:
        async with self._lock:
            return await self._finish_on_cancel(self._snapshot())

    async def _finish_on_cancel(self, coroutine: Any) -> Any:
        operation = asyncio.create_task(coroutine)
        result, cancellation = await self._complete_despite_cancellation(operation)
        if cancellation is not None:
            raise cancellation
        return result

    async def _complete_despite_cancellation(
        self, operation: asyncio.Task[Any]
    ) -> tuple[Any, asyncio.CancelledError | None]:
        cancellation: asyncio.CancelledError | None = None
        while not operation.done():
            try:
                await asyncio.shield(operation)
            except asyncio.CancelledError as exc:
                if cancellation is None:
                    cancellation = exc
            except BaseException:
                break
        try:
            result = operation.result()
        except BaseException:
            if cancellation is not None:
                raise cancellation from None
            raise
        return result, cancellation

    async def _snapshot(self) -> Frame | None:
        if self._capture is None or self._latest_raw is None:
            raise CameraError("视频回放尚未启动")
        if self._epoch is not None:
            assert self._fps is not None
            assert self._frame_count is not None
            elapsed = max(0.0, self._clock.now() - self._epoch)
            target_index = min(math.floor(elapsed * self._fps), self._frame_count - 1)
            await self._move_to(target_index)
        try:
            payload = await self._run_in_thread(self._encode, self._latest_raw)
        except CameraError:
            raise
        except Exception:
            raise CameraError("视频帧 JPEG 编码失败") from None
        return Frame(
            payload=payload,
            media_type="image/jpeg",
            width=self._width,
            height=self._height,
            captured_at=self._clock.now(),
        )

    async def restart(self) -> None:
        async with self._lock:
            await self._finish_on_cancel(self._restart())

    async def _restart(self) -> None:
        if self._capture is None:
            raise CameraError("视频回放尚未启动")
        raw = await self._seek_and_read(0)
        self._latest_raw = raw
        self._current_index = 0
        self._epoch = self._clock.now()
        self._at_eof = False

    async def stop(self) -> None:
        async with self._lock:
            await self._stop()

    async def _stop(self) -> None:
        capture = self._capture
        if capture is None:
            return
        self._capture = None
        self._fps = None
        self._frame_count = None
        self._latest_raw = None
        self._current_index = None
        self._epoch = None
        self._at_eof = False
        try:
            await self._run_in_thread(capture.release)
        except Exception:
            raise CameraError("无法释放视频文件") from None

    async def _move_to(self, target_index: int) -> None:
        assert self._capture is not None
        assert self._current_index is not None
        if self._at_eof and target_index >= self._current_index:
            return
        if target_index < self._current_index:
            raw = await self._seek_and_read(target_index)
            self._latest_raw = raw
            self._current_index = target_index
            self._at_eof = False
            return
        while self._current_index < target_index:
            try:
                ok, raw = await self._run_in_thread(self._capture.read)
            except Exception:
                raise CameraError("无法读取视频帧") from None
            if not ok:
                self._at_eof = True
                return
            self._latest_raw = raw
            self._current_index += 1

    async def _seek_and_read(self, index: int) -> Any:
        assert self._capture is not None
        try:
            if not await self._run_in_thread(
                self._capture.set, self._cv2.CAP_PROP_POS_FRAMES, index
            ):
                raise CameraError("无法定位视频帧")
            ok, raw = await self._run_in_thread(self._capture.read)
            if not ok:
                raise CameraError("无法读取视频帧")
        except CameraError:
            raise
        except Exception:
            raise CameraError("无法定位或读取视频帧") from None
        return raw

    def _encode(self, raw: Any) -> bytes:
        resized = self._cv2.resize(raw, (self._width, self._height))
        ok, encoded = self._cv2.imencode(
            ".jpg",
            resized,
            [int(self._cv2.IMWRITE_JPEG_QUALITY), self._jpeg_quality],
        )
        if not ok:
            raise CameraError("视频帧 JPEG 编码失败")
        return encoded.tobytes()


class CamAdapter:
    manifest = CAMERA_MANIFEST

    def __init__(self, source: FrameSource, store: MediaStore) -> None:
        self._source = source
        self._store = store

    async def dispatch(
        self,
        op: str,
        request: dict[str, object],
        ctx: DispatchContext,
    ) -> Handoff:
        del ctx
        if op != "snapshot":
            return Handoff(
                outcome="failed",
                trust="untrusted_external",
                content={"error": "unknown_op", "op": op},
            )
        if request:
            return Handoff(
                outcome="failed",
                trust="untrusted_external",
                content={"error": "invalid_params", "op": "snapshot"},
            )
        try:
            frame = await self._source.snapshot()
        except CameraError:
            frame = None
        except Exception:
            return Handoff(
                outcome="unknown",
                trust="untrusted_external",
                content={"error": "adapter_exception", "op": "snapshot"},
            )
        if frame is None:
            # `verifies=("snapshot",)` renders the recheck probe as conclusive, which is
            # right whenever the source is alive — re-looking really does settle "what can
            # you see now". It is wrong for this one cause: the observing mechanism itself
            # is down, so an immediate recheck returns the same `unknown`, and R49's fence
            # deliberately blocks only once (permanent blocking would be the loop deciding
            # on the model's behalf). Rather than change that, say why a recheck is futile
            # and leave the informed choice where R49 puts it.
            return Handoff(
                outcome="unknown",
                trust="untrusted_external",
                content={
                    "error": "capture_unavailable",
                    "op": "snapshot",
                    "recheck": "not_useful_until_capture_recovers",
                },
            )
        try:
            entry = self._store.put(
                frame.payload,
                media_type=frame.media_type,
                width=frame.width,
                height=frame.height,
                captured_at=frame.captured_at,
            )
        except ValueError:
            return Handoff(
                outcome="failed",
                trust="untrusted_external",
                content={"error": "media_store_rejected", "op": "snapshot"},
            )
        except Exception:
            return Handoff(
                outcome="unknown",
                trust="untrusted_external",
                content={"error": "adapter_exception", "op": "snapshot"},
            )
        return Handoff(
            outcome="ok",
            trust="untrusted_external",
            content={
                "media_ref": entry.ref,
                "digest": entry.digest,
                "media_type": entry.media_type,
                "width": entry.width,
                "height": entry.height,
                "captured_at": entry.captured_at,
            },
        )
