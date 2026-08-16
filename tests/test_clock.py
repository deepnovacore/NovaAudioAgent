"""VirtualClock: time only advances via advance_to; sleep is the only suspension point.

These four tests pin down the "time" source among the four determinism sources
(06-verification.md). Every "does not happen" assertion is paired with a
"did indeed happen" twin — a clock that never wakes anything up would pass
all the "didn't wake" assertions.
"""

from __future__ import annotations

import asyncio
import math

import pytest

from nova_audio_agent.clock import RealClock, VirtualClock


async def test_sleep_resumes_only_after_advance_to() -> None:
    clock = VirtualClock()
    woke_at: list[float] = []

    async def sleeper() -> None:
        await clock.sleep(5.0)
        woke_at.append(clock.now())

    task = asyncio.create_task(sleeper())
    await asyncio.sleep(0)  # let sleeper run to the suspension point

    assert woke_at == []  # time hasn't advanced → must not wake
    assert clock.now() == 0.0
    assert clock.waiter_count() == 1
    assert clock.next_timer_ts() == 5.0

    clock.advance_to(5.0)
    await asyncio.sleep(0)  # let it run to completion after waking

    assert woke_at == [5.0]  # positive twin: it did wake, and sees the advanced time
    assert clock.waiter_count() == 0
    assert clock.next_timer_ts() is None
    await task


async def test_advance_to_wakes_only_the_due_sleepers() -> None:
    clock = VirtualClock()
    woke: list[str] = []

    async def sleeper(name: str, duration: float) -> None:
        await clock.sleep(duration)
        woke.append(name)

    tasks = [
        asyncio.create_task(sleeper("early", 1.0)),
        asyncio.create_task(sleeper("late", 9.0)),
    ]
    await asyncio.sleep(0)

    clock.advance_to(1.0)
    await asyncio.sleep(0)
    assert woke == ["early"]  # the one whose time is up woke
    assert clock.waiter_count() == 1  # the one not yet due is still asleep

    clock.advance_to(9.0)
    await asyncio.sleep(0)
    assert woke == ["early", "late"]
    await asyncio.gather(*tasks)


async def test_infinite_sleep_never_schedules_a_timer() -> None:
    """The hung executor (scenario 3) sleeps for inf: it must not pin the loop to a moment that will never arrive."""
    clock = VirtualClock()

    async def hung() -> None:
        await clock.sleep(math.inf)

    task = asyncio.create_task(hung())
    await asyncio.sleep(0)

    assert clock.waiter_count() == 1  # it is indeed asleep
    assert clock.next_timer_ts() is None  # but it can't schedule the next advance target

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


def test_advance_to_rejects_backwards() -> None:
    clock = VirtualClock(start=3.0)
    clock.advance_to(4.0)
    assert clock.now() == 4.0

    with pytest.raises(ValueError, match="倒流"):
        clock.advance_to(3.5)


def test_real_clock_is_monotonic() -> None:
    clock = RealClock()
    first = clock.now()
    second = clock.now()
    assert isinstance(first, float)
    assert second >= first
