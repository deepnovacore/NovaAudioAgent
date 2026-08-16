"""Clock port: the "time" source among the four deterministic sources (06-verification.md).

deadline / cooldown / expiry / watermark all go through it, never touching the wall
clock. Without a virtual clock, the "timeout speech" test would have to really wait
30 seconds, and that was the precondition for stage A's original global
test-duration observable. The current phase budget is recorded in R70.

Module boundary: this file is the **only** place in the whole repo allowed to contain
time / asyncio.sleep, the sole exception being the `await asyncio.sleep(0)` line in
runtime.py. This is statically enforced by tests/test_wallclock_hygiene.py.
"""

from __future__ import annotations

import asyncio
import heapq
import math
import time
from typing import Any, Protocol


class Clock(Protocol):
    """The clock as seen by executors and ports. They are only allowed to suspend on sleep().

    This structural protocol lets components measure and suspend without owning time
    progression. Runtime's two top-level drivers remain mode-specific: run() requires
    VirtualClock, while serve() requires the built-in RealClock.

    This isn't just a hygiene rule — it's the precondition for the runtime loop's
    termination: the loop decides whether there's still a task to run using
    "alive task count - clock.waiter_count()". A task suspended anywhere else would
    make this difference permanently positive, so time would never advance
    (no events lost, but no progress either — see docs/plans/v3-stage-a.md C3 hole 3).
    """

    def now(self) -> float: ...

    async def sleep(self, duration: float) -> None: ...


class VirtualClock:
    """Virtual clock: now only advances via advance_to(); sleep registers a future in
    the timer heap.

    **Awaiting a sleep() directly outside the runtime loop hangs forever**, because
    nothing advances time. This isn't a flaw, it's the price of determinism: time
    moving forward is the loop's decision, not the wall clock's. To run a coroutine
    that sleeps in a test, spawn it into the Runtime.
    """

    def __init__(self, start: float = 0.0) -> None:
        self._now = start
        self._seq = 0
        # Heap element = (due virtual time, insertion sequence number, future, sleeping task).
        # The sequence number makes same-tick wake order reproducible; the task lets
        # the runtime judge runnability by set difference.
        self._waiters: list[tuple[float, int, asyncio.Future[None], asyncio.Task[Any] | None]] = []

    def now(self) -> float:
        return self._now

    async def sleep(self, duration: float) -> None:
        if math.isnan(duration):
            # NaN would create a timer that never comes due (nan <= nan is always
            # false), so the loop would keep "advancing" to NaN yet wake nothing.
            # Block it at the entrance instead of letting it become an infinite loop.
            raise ValueError("睡眠时长不能是 NaN")
        if duration < 0:
            raise ValueError(f"睡眠时长不能为负：{duration}")
        loop = asyncio.get_running_loop()
        future: asyncio.Future[None] = loop.create_future()
        self._seq += 1
        heapq.heappush(
            self._waiters, (self._now + duration, self._seq, future, asyncio.current_task())
        )
        await future

    def waiter_count(self) -> int:
        """Number of coroutines still asleep on this clock. Woken or cancelled ones don't count."""
        return sum(1 for _, _, future, _task in self._waiters if not future.done())

    def waiting_tasks(self) -> set[asyncio.Task[Any]]:
        """Set of tasks currently asleep on this clock.

        The runtime uses a **set difference** rather than "alive count - asleep
        count" to decide whether there's still a task to run: when a task spawns a
        child task internally (e.g. gather-ing two sleeps), the subtraction would
        count "still a runnable coroutine" as 0, so virtual time would advance
        prematurely and same-tick events would get split across two timestamps.
        Set difference has no such hole — the worst case is the loop stalling in
        place without advancing time, which is the declared correct failure mode.
        """
        return {
            task for _, _, future, task in self._waiters if task is not None and not future.done()
        }

    def next_timer_ts(self) -> float | None:
        """The earliest due time; returns None when there's no timer, or only inf (stuck) remain."""
        self._discard_finished()
        if not self._waiters:
            return None
        ts = self._waiters[0][0]
        return None if math.isinf(ts) else ts

    def _discard_finished(self) -> None:
        while self._waiters and self._waiters[0][2].done():
            heapq.heappop(self._waiters)

    def advance_to(self, ts: float) -> None:
        """Advance virtual time to ts, and mark sleepers that are now due as ready.

        Note this only **marks them ready** — those coroutines haven't run yet. The
        runtime's loop must return to the top after advancing and drain all
        runnable tasks first, otherwise same-tick events would land on two
        different timestamps (docs/plans/v3-stage-a.md C3 hole 2).
        """
        if math.isnan(ts):
            raise ValueError("虚拟时间不能推进到 NaN")
        if ts < self._now:
            raise ValueError(f"虚拟时间不能倒流：{self._now} → {ts}")
        self._now = ts
        while self._waiters and self._waiters[0][0] <= ts:
            _, _, future, _task = heapq.heappop(self._waiters)
            if not future.done():
                future.set_result(None)


class RealClock:
    """Production clock. The only implementation in the repo allowed to touch wall time.

    **It only has the two things from the Clock protocol — no `waiting_tasks` /
    `next_timer_ts` / `advance_to`.** Those three answer "who's sleeping, when's the
    next tick, advance to that tick" — questions that can't and needn't be asked of
    the wall clock (it just runs on its own). Runtime.run() uses the virtual-only
    controls for deterministic run-to-idle behavior; Runtime.serve() waits on real
    ingress, deadlines, or explicit shutdown.
    """

    def now(self) -> float:
        return time.monotonic()

    async def sleep(self, duration: float) -> None:
        await asyncio.sleep(duration)
