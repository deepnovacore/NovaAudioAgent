from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import pytest

from nova_audio_agent.clock import RealClock, VirtualClock
from nova_audio_agent.events import AssistantSpoken, Event, ModelDone, UserInput
from nova_audio_agent.executors.sims import FAST_SIM_POLICY, FastSim
from nova_audio_agent.memory import Memory
from nova_audio_agent.ports import ActionDelta, ActionOutput, DelegateRequest, FastBrainDelta
from nova_audio_agent.runtime import Runtime


async def _yield_scheduler(turns: int = 10) -> None:
    for _ in range(turns):
        await asyncio.sleep(0)


class _OtherClock:
    def now(self) -> float:
        return 0.0

    async def sleep(self, duration: float) -> None:
        del duration


class _DispatchingBrain:
    async def call(self, _view: object) -> AsyncIterator[FastBrainDelta]:
        yield ActionDelta(
            action=ActionOutput(
                act="delegate",
                delegate=DelegateRequest(
                    executor="fast_sim",
                    op="set_light",
                    request={"room": "living-room", "brightness": 20},
                    origin_ref="conversation:1",
                ),
            )
        )


class _BlockingBrain:
    def __init__(self, clock: RealClock) -> None:
        self.clock = clock
        self.started = asyncio.Event()
        self.cancelled = False

    async def call(self, _view: object) -> AsyncIterator[FastBrainDelta]:
        self.started.set()
        try:
            await self.clock.sleep(3600)
        finally:
            self.cancelled = True
        if False:  # pragma: no cover - keeps this an async generator
            yield


class _FailingBrain:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def call(self, _view: object) -> AsyncIterator[FastBrainDelta]:
        self.started.set()
        await self.release.wait()
        raise RuntimeError("model failed")
        if False:  # pragma: no cover - keeps this an async generator
            yield


async def test_assistant_spoken_commits_audible_speech_to_conversation() -> None:
    """Renderer-acknowledged assistant speech is the only path into spoken Memory."""
    runtime = Runtime(clock=RealClock(), memory=Memory())

    runtime.apply(
        AssistantSpoken(
            text="已经说完了。",
            utterance_id="utterance-1",
            delivery="spoken",
            played_ms=900,
        )
    )
    runtime.apply(
        AssistantSpoken(
            text="说到一半",
            utterance_id="utterance-2",
            delivery="interrupted",
            played_ms=120,
        )
    )

    items = runtime.memory.channels["conversation"].items
    assert [item.trust for item in items] == ["trusted_system", "trusted_system"]
    assert items[0].content == {
        "text": "已经说完了。",
        "utterance_id": "utterance-1",
        "delivery": "spoken",
        "played_ms": 900,
    }
    assert items[1].content["delivery"] == "interrupted"


async def test_serve_stays_alive_while_idle_until_explicit_stop() -> None:
    stop = asyncio.Event()
    runtime = Runtime(clock=RealClock(), memory=Memory())

    serving = asyncio.create_task(runtime.serve(stop))
    await _yield_scheduler()

    assert not serving.done()
    stop.set()
    await asyncio.wait_for(serving, timeout=0.2)


async def test_external_post_wakes_serve_and_observer_runs_after_lifecycle() -> None:
    stop = asyncio.Event()
    observed = asyncio.Event()
    adapter = FastSim(latency=0)
    runtime = Runtime(
        clock=RealClock(),
        memory=Memory(policies=(FAST_SIM_POLICY,)),
        fastbrain=_DispatchingBrain(),
        executors={"fast_sim": adapter},
    )

    def inspect(event: Event) -> None:
        if isinstance(event, ModelDone):
            assert tuple(delegate.delegate_id for delegate in runtime.delegates.snapshot()) == (
                "d-1",
            )
            observed.set()

    runtime.observe(inspect)
    serving = asyncio.create_task(runtime.serve(stop))
    await _yield_scheduler()
    assert not serving.done()
    runtime.post(UserInput("dim the light"))

    await asyncio.wait_for(observed.wait(), timeout=0.2)
    stop.set()
    await asyncio.wait_for(serving, timeout=0.2)


async def test_explicit_stop_cancels_background_model_job() -> None:
    stop = asyncio.Event()
    clock = RealClock()
    brain = _BlockingBrain(clock)
    runtime = Runtime(clock=clock, memory=Memory(), fastbrain=brain)
    serving = asyncio.create_task(runtime.serve(stop))
    runtime.post(UserInput("hello"))

    await asyncio.wait_for(brain.started.wait(), timeout=0.2)
    await _yield_scheduler()
    assert not serving.done()
    assert not brain.cancelled

    stop.set()
    await asyncio.wait_for(serving, timeout=0.2)

    assert brain.cancelled
    assert not runtime.delegates.snapshot()


async def test_failed_background_job_wakes_idle_serve_and_propagates() -> None:
    stop = asyncio.Event()
    brain = _FailingBrain()
    runtime = Runtime(clock=RealClock(), memory=Memory(), fastbrain=brain)
    serving = asyncio.create_task(runtime.serve(stop))
    await _yield_scheduler()
    runtime.post(UserInput("hello"))
    await asyncio.wait_for(brain.started.wait(), timeout=0.2)
    await _yield_scheduler()
    brain.release.set()

    with pytest.raises(RuntimeError, match="model failed"):
        await asyncio.wait_for(serving, timeout=0.2)


async def test_failure_raised_during_shutdown_is_not_silently_swallowed() -> None:
    stop = asyncio.Event()
    started = asyncio.Event()
    runtime = Runtime(clock=RealClock(), memory=Memory())

    async def fail_when_cancelled() -> None:
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError as exc:
            raise RuntimeError("shutdown failed") from exc

    runtime.spawn(
        fail_when_cancelled(),
        lambda _job_id, _result: UserInput("unused"),
    )
    serving = asyncio.create_task(runtime.serve(stop))
    await asyncio.wait_for(started.wait(), timeout=0.2)
    stop.set()

    with pytest.raises(RuntimeError, match="shutdown failed"):
        await asyncio.wait_for(serving, timeout=0.2)


async def test_shutdown_cancels_once_and_awaits_async_cleanup() -> None:
    stop = asyncio.Event()
    started = asyncio.Event()
    cleanup_started = asyncio.Event()
    cleanup_release = asyncio.Event()
    cleanup_finished = False
    runtime = Runtime(clock=RealClock(), memory=Memory())

    async def cleanup_after_cancel() -> None:
        nonlocal cleanup_finished
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cleanup_started.set()
            await cleanup_release.wait()
            cleanup_finished = True
            raise

    runtime.spawn(
        cleanup_after_cancel(),
        lambda _job_id, _result: UserInput("unused"),
    )
    serving = asyncio.create_task(runtime.serve(stop))
    await asyncio.wait_for(started.wait(), timeout=0.2)
    stop.set()
    await asyncio.wait_for(cleanup_started.wait(), timeout=0.2)

    assert not serving.done()
    cleanup_release.set()
    await asyncio.wait_for(serving, timeout=0.2)

    assert cleanup_finished is True


async def test_repeated_serve_cancellation_cannot_interrupt_async_cleanup() -> None:
    started = asyncio.Event()
    cleanup_started = asyncio.Event()
    cleanup_release = asyncio.Event()
    cleanup_finished = False
    runtime = Runtime(clock=RealClock(), memory=Memory())

    async def cleanup_after_cancel() -> None:
        nonlocal cleanup_finished
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cleanup_started.set()
            await cleanup_release.wait()
            cleanup_finished = True
            raise

    runtime.spawn(
        cleanup_after_cancel(),
        lambda _job_id, _result: UserInput("unused"),
    )
    serving = asyncio.create_task(runtime.serve(asyncio.Event()))
    await asyncio.wait_for(started.wait(), timeout=0.2)

    serving.cancel()
    await asyncio.wait_for(cleanup_started.wait(), timeout=0.2)
    serving.cancel()
    await asyncio.sleep(0)

    assert not serving.done()
    cleanup_release.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(serving, timeout=0.2)
    assert cleanup_finished is True


async def test_run_and_serve_reject_the_wrong_clock_type() -> None:
    with pytest.raises(TypeError, match=r"run\(\).*VirtualClock"):
        await Runtime(clock=RealClock(), memory=Memory()).run()

    with pytest.raises(
        TypeError,
        match=r"serve\(stop\).*RealClock.*VirtualClock.*run\(\)",
    ):
        await asyncio.wait_for(
            Runtime(clock=VirtualClock(), memory=Memory()).serve(asyncio.Event()),
            timeout=0.05,
        )

    with pytest.raises(TypeError, match=r"serve\(stop\).*RealClock"):
        await asyncio.wait_for(
            Runtime(clock=_OtherClock(), memory=Memory()).serve(asyncio.Event()),
            timeout=0.05,
        )
