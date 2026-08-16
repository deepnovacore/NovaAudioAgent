import asyncio
from collections import defaultdict, deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

ClockMs = Callable[[], int]
Sleep = Callable[[float], Awaitable[None]]


@dataclass(slots=True)
class PlaybackMetrics:
    first_rendered_ms: int | None = None
    stop_requested_ms: int | None = None
    last_rendered_ms: int | None = None
    cleared_bytes: int = 0
    late_discarded_bytes: int = 0
    rendered_after_fence_bytes: int = 0


@dataclass(frozen=True, slots=True)
class PlaybackStop:
    response_id: str
    at_ms: int
    cleared_bytes: int


class RealtimePcmSink:
    FRAME_BYTES = 960

    def __init__(self, *, clock_ms: ClockMs | None = None, sleep: Sleep = asyncio.sleep) -> None:
        self._clock_ms = clock_ms or _monotonic_ms
        self._sleep = sleep
        self._queue: deque[tuple[str, bytes, int]] = deque()
        self._epochs: dict[str, int] = defaultdict(int)
        self._remainders: dict[str, bytearray] = defaultdict(bytearray)
        self._rendered: dict[str, bytearray] = defaultdict(bytearray)
        self._condition = asyncio.Condition()
        self._finished = False
        self.metrics = PlaybackMetrics()
        self.first_rendered = asyncio.Event()

    async def run(self) -> None:
        while True:
            async with self._condition:
                await self._condition.wait_for(lambda: self._queue or self._finished)
                if not self._queue:
                    return
                response_id, frame, epoch = self._queue.popleft()
                if self._epochs[response_id] != epoch:
                    self.metrics.rendered_after_fence_bytes += len(frame)
                    continue
                self._rendered[response_id].extend(frame)
                now_ms = self._clock_ms()
                if self.metrics.first_rendered_ms is None:
                    self.metrics.first_rendered_ms = now_ms
                    self.first_rendered.set()
                self.metrics.last_rendered_ms = now_ms
            await self._sleep(len(frame) / 48_000)

    async def enqueue(self, response_id: str, pcm: bytes) -> bool:
        if not pcm:
            raise ValueError("PCM must be non-empty")
        if len(pcm) % 2:
            raise ValueError("PCM must contain 16-bit samples")

        async with self._condition:
            if self._finished:
                raise RuntimeError("playback sink is finished")
            if self._epochs[response_id]:
                self.metrics.late_discarded_bytes += len(pcm)
                return False
            remainder = self._remainders[response_id]
            remainder.extend(pcm)
            complete_bytes = len(remainder) - len(remainder) % self.FRAME_BYTES
            for start in range(0, complete_bytes, self.FRAME_BYTES):
                self._queue.append(
                    (
                        response_id,
                        bytes(remainder[start : start + self.FRAME_BYTES]),
                        self._epochs[response_id],
                    )
                )
            del remainder[:complete_bytes]
            self._condition.notify()
        return True

    async def stop_response(self, response_id: str) -> PlaybackStop:
        async with self._condition:
            self._epochs[response_id] += 1
            cleared_bytes = 0
            retained: deque[tuple[str, bytes, int]] = deque()
            while self._queue:
                item = self._queue.popleft()
                if item[0] == response_id:
                    cleared_bytes += len(item[1])
                else:
                    retained.append(item)
            self._queue = retained
            cleared_bytes += len(self._remainders.pop(response_id, ()))
            self.metrics.cleared_bytes += cleared_bytes
            at_ms = self._clock_ms()
            self.metrics.stop_requested_ms = at_ms
            return PlaybackStop(response_id, at_ms, cleared_bytes)

    async def finish(self) -> None:
        async with self._condition:
            self._finished = True
            self._condition.notify_all()

    def rendered_pcm(self, response_id: str) -> bytes:
        return bytes(self._rendered[response_id])


def _monotonic_ms() -> int:
    return round(asyncio.get_running_loop().time() * 1000)
