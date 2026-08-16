import asyncio

import pytest

from scripts.realtime_probe.playback import RealtimePcmSink


class FakeClock:
    def __init__(self) -> None:
        self._now_ms = 0

    def now_ms(self) -> int:
        return self._now_ms

    def advance_ms(self, value: int) -> None:
        self._now_ms += value


@pytest.mark.asyncio
async def test_stop_fences_queued_inflight_and_late_frames() -> None:
    clock = FakeClock()
    sleep_entered = asyncio.Event()
    release_sleep = asyncio.Event()

    async def controlled_sleep(seconds: float) -> None:
        clock.advance_ms(round(seconds * 1000))
        sleep_entered.set()
        await release_sleep.wait()

    sink = RealtimePcmSink(clock_ms=clock.now_ms, sleep=controlled_sleep)
    player = asyncio.create_task(sink.run())
    await sink.enqueue("response-progress", b"\x01\x00" * 480)
    await sleep_entered.wait()
    await sink.enqueue("response-progress", b"\x02\x00" * 480)

    stop = await sink.stop_response("response-progress")
    accepted = await sink.enqueue("response-progress", b"\x03\x00" * 480)
    release_sleep.set()
    await sink.finish()
    await player

    assert accepted is False
    assert stop.cleared_bytes == 960
    assert sink.metrics.late_discarded_bytes == 960
    assert sink.metrics.rendered_after_fence_bytes == 0
    assert sink.rendered_pcm("response-progress") == b"\x01\x00" * 480


@pytest.mark.asyncio
async def test_sink_rejects_empty_or_unaligned_pcm() -> None:
    sink = RealtimePcmSink()
    with pytest.raises(ValueError, match="non-empty"):
        await sink.enqueue("response-1", b"")
    with pytest.raises(ValueError, match="16-bit"):
        await sink.enqueue("response-1", b"\x00")


@pytest.mark.asyncio
async def test_sink_combines_deltas_into_full_frames_only() -> None:
    durations: list[float] = []

    async def record_sleep(seconds: float) -> None:
        durations.append(seconds)

    sink = RealtimePcmSink(sleep=record_sleep)
    await sink.enqueue("response-1", b"\x01\x00" * 240)
    await sink.enqueue("response-1", b"\x02\x00" * 240)
    await sink.finish()
    await sink.run()

    assert sink.rendered_pcm("response-1") == b"\x01\x00" * 240 + b"\x02\x00" * 240
    assert durations == [0.02]


@pytest.mark.asyncio
async def test_sink_does_not_play_an_incomplete_final_frame() -> None:
    durations: list[float] = []

    async def record_sleep(seconds: float) -> None:
        durations.append(seconds)

    sink = RealtimePcmSink(sleep=record_sleep)
    await sink.enqueue("response-1", b"\x01\x00" * 240)
    await sink.finish()
    await sink.run()

    assert sink.rendered_pcm("response-1") == b""
    assert durations == []


@pytest.mark.asyncio
async def test_stop_clears_response_remainder() -> None:
    sink = RealtimePcmSink()
    await sink.enqueue("response-1", b"\x01\x00" * 240)

    stop = await sink.stop_response("response-1")
    accepted = await sink.enqueue("response-1", b"\x02\x00" * 240)

    assert stop.cleared_bytes == 480
    assert sink.metrics.cleared_bytes == 480
    assert accepted is False
    assert sink.metrics.late_discarded_bytes == 480


@pytest.mark.asyncio
async def test_finish_rejects_later_enqueue() -> None:
    sink = RealtimePcmSink()
    await sink.finish()

    with pytest.raises(RuntimeError, match="finished"):
        await sink.enqueue("response-1", b"\x01\x00" * 480)


@pytest.mark.asyncio
async def test_finish_and_enqueue_race_leaves_no_unconsumed_frame() -> None:
    sink = RealtimePcmSink()
    player = asyncio.create_task(sink.run())

    finished, enqueued = await asyncio.gather(
        sink.finish(),
        sink.enqueue("response-1", b"\x01\x00" * 480),
        return_exceptions=True,
    )
    await player

    assert finished is None
    if enqueued is True:
        assert sink.rendered_pcm("response-1") == b"\x01\x00" * 480
    else:
        assert isinstance(enqueued, RuntimeError)
        assert sink.rendered_pcm("response-1") == b""
