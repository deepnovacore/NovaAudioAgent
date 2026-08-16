"""The three-branch ordering and liveness of the loop skeleton (Phase A green items 5, 6).

Branch order is the one place in this skeleton that's easy to get wrong, and wrong
in a way that doesn't show up right away:
① drain runnable tasks first → ② then take ready events → ③ only advance virtual
time when neither is available.

Neither the queue-ordering unit tests (test_event_queue.py) nor the liveness unit
tests catch the "dequeue happens before advance_to" bug, so there's an end-to-end
same-instant race case here.
"""

from __future__ import annotations

import asyncio

import pytest
from fakes import finished_call

from nova_audio_agent.calls import CallRecord
from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.events import (
    Compress,
    CompressDone,
    Deadline,
    HandoffEvent,
    ModelDone,
    SpeakEnd,
    SpeakStart,
    UserInput,
)
from nova_audio_agent.memory import CONVERSATION_CHANNEL, Memory
from nova_audio_agent.runtime import Runtime
from policies import SIM_POLICIES

DEADLINE_AT = 5.0


def _dispatch_with_deadline(runtime: Runtime, clock: VirtualClock, *, latency: float) -> None:
    """Dispatch one activity: the deadline is enqueued at dispatch time; the handoff is posted by the executor after `latency`."""
    runtime.post(Deadline(delegate_id="d-1"), delay=DEADLINE_AT)

    async def dispatch() -> dict[str, int]:
        await clock.sleep(latency)
        return {"brightness": 30}

    runtime.spawn(
        dispatch(),
        lambda _job_id, result: HandoffEvent(
            channel="slow_sim",
            delegate_id="d-1",
            origin_ref="conversation:1",
            outcome="ok",
            trust="trusted_system",
            content=result,
        ),
    )


def _terminate(events: list) -> dict[str, str]:
    """A **test-local** stand-in for the termination rules in 05-executors.md (the real implementation lands in B3).

    Rule 1: handoff timestamp <= deadline -> handoff wins, immediately removed from in_flight.
    Rule 3: a deadline landing on a delegate no longer in in_flight -> no-op.
    This is used only to translate "event order" into "what outcome the delegate got";
    the Phase A trunk has no in_flight, and isn't allowed to.
    """
    in_flight = {"d-1"}
    outcomes: dict[str, str] = {}
    for event in events:
        if event.KIND == "handoff" and event.delegate_id in in_flight:
            in_flight.discard(event.delegate_id)
            outcomes[event.delegate_id] = event.outcome
        elif event.KIND == "deadline" and event.delegate_id in in_flight:
            in_flight.discard(event.delegate_id)
            outcomes[event.delegate_id] = "unknown"
    return outcomes


async def test_handoff_landing_exactly_on_the_deadline_wins() -> None:
    """Green item 5: same-instant race. Missing either the loop branch order or kind_rank turns this red."""
    clock = VirtualClock()
    runtime = Runtime(clock=clock, memory=Memory(policies=SIM_POLICIES))
    _dispatch_with_deadline(runtime, clock, latency=DEADLINE_AT)

    await runtime.run()

    kinds = [event.KIND for event in runtime.applied]
    assert kinds == ["handoff", "deadline"]  # ① handoff is applied first
    assert _terminate(runtime.applied) == {"d-1": "ok"}  # ② terminates with ok
    assert all(getattr(event, "outcome", None) != "unknown" for event in runtime.applied)  # ③

    handoff = runtime.applied[0]
    assert handoff.ts == DEADLINE_AT  # both events really do land on the same ts
    assert runtime.applied[1].ts == DEADLINE_AT


async def test_dispatch_finishing_before_the_deadline_is_applied() -> None:
    """Liveness 1: for a sim that only suspends on clock.sleep(), the event it posts on waking must actually be applied."""
    clock = VirtualClock()
    runtime = Runtime(clock=clock, memory=Memory(policies=SIM_POLICIES))
    _dispatch_with_deadline(runtime, clock, latency=2.0)

    await runtime.run()

    assert [event.KIND for event in runtime.applied] == ["handoff", "deadline"]
    assert runtime.applied[0].ts == 2.0
    assert runtime.applied[0].content == {"brightness": 30}
    assert _terminate(runtime.applied) == {"d-1": "ok"}


async def test_loop_advances_to_a_lone_future_event() -> None:
    """Liveness 2: only a single future-timestamped deadline remains in the queue, with no coroutine sleeping.

    The advance target must look at both the queue and the clock. Looking only at the
    clock hits a break — that deadline never fires, and it's the only trigger source
    for termination rule 2 in 05-executors.md.
    """
    clock = VirtualClock()
    runtime = Runtime(clock=clock, memory=Memory(policies=SIM_POLICIES))
    runtime.post(Deadline(delegate_id="d-1"), delay=30.0)

    await runtime.run()

    assert [event.KIND for event in runtime.applied] == ["deadline"]
    assert clock.now() == 30.0


async def test_task_suspended_outside_the_clock_stalls_without_losing_events() -> None:
    """Liveness 3: deliberately write a broken sim (suspended outside clock.sleep()).

    The correct failure mode is to **not advance time and not drop events**, rather
    than skip it and keep running. "Never advances" can't be proven under finite
    observation, so the assertion is written in bounded form.
    """
    clock = VirtualClock()
    runtime = Runtime(clock=clock, memory=Memory(policies=SIM_POLICIES))
    runtime.post(Deadline(delegate_id="d-1"), delay=30.0)
    started: list[str] = []

    async def stuck() -> None:
        started.append("ran")
        await asyncio.Event().wait()  # suspended outside the clock

    runtime.spawn(stuck(), lambda job_id, _result: ModelDone(slot="fast", job_id=job_id))

    await runtime.run(max_steps=50)

    # Positive twin: the loop really did schedule it. Without this, a run() that
    # "returns immediately" would also pass everything.
    assert started == ["ran"]
    assert clock.now() == 0.0  # time did not move
    assert runtime.applied == []  # event was not applied
    assert len(runtime.queue) == 1  # nor was it skipped -- still in the queue


async def test_job_holding_two_clock_waiters_stalls_instead_of_reordering() -> None:
    """One job runs two concurrent clock.sleeps internally (violating the "single suspension point" convention).

    "count alive - count sleeping" computes -1 here, so the loop thinks there's
    nothing to do and advances time early, and that deadline gets processed ahead of
    the same-instant handoff -- a false "I'm not sure". The set-difference approach
    doesn't have this hole: the worst it does is stall in place without advancing time.
    """
    clock = VirtualClock()
    runtime = Runtime(clock=clock, memory=Memory(policies=SIM_POLICIES))
    runtime.post(Deadline(delegate_id="d-1"), delay=DEADLINE_AT)

    async def two_waiters() -> dict[str, int]:
        await asyncio.gather(clock.sleep(DEADLINE_AT), clock.sleep(DEADLINE_AT * 2))
        return {"brightness": 30}

    runtime.spawn(
        two_waiters(),
        lambda _job_id, result: HandoffEvent(
            channel="slow_sim",
            delegate_id="d-1",
            origin_ref="conversation:1",
            outcome="ok",
            trust="trusted_system",
            content=result,
        ),
    )

    await runtime.run(max_steps=50)

    assert clock.now() == 0.0  # did not advance early
    assert runtime.applied == []  # that deadline was not processed ahead of time
    assert len(runtime.queue) == 1


async def test_apply_accepts_every_event_kind() -> None:
    """Type coverage: kinds Phase A doesn't need are no-ops for now, but must still pass through the apply dispatch table."""
    clock = VirtualClock()
    runtime = Runtime(clock=clock, memory=Memory(policies=SIM_POLICIES))
    runtime.post(UserInput(text="hi"))
    runtime.post(
        HandoffEvent(
            channel="fast_sim",
            delegate_id="d-1",
            origin_ref="conversation:1",
            outcome="ok",
            trust="trusted_system",
            content={},
        )
    )
    runtime.post(Deadline(delegate_id="d-1"))
    runtime.post(Compress(channel="conversation"))
    runtime.post(CompressDone(channel="conversation", job_id="job-0"))
    runtime.post(SpeakStart(utterance_id="u-1", priority=100))
    runtime.post(SpeakEnd(utterance_id="u-1"))
    # The model_done line must be spawned, not hand-written: starting from B1 it
    # fetches the result from the job table, and a job_id made up out of thin air
    # doesn't exist on the real path (see fakes.finished_call).

    async def call() -> CallRecord:
        return finished_call()

    runtime.spawn(call(), lambda job_id, _result: ModelDone(slot="fast", job_id=job_id))

    await runtime.run()

    assert len(runtime.applied) == 8


async def test_user_input_keeps_text_and_media_refs_on_one_conversation_item() -> None:
    clock = VirtualClock()
    runtime = Runtime(clock=clock, memory=Memory(policies=SIM_POLICIES))
    runtime.post(UserInput(text="比较图片", media_refs=("media:a", "media:b")))

    await runtime.run()

    (item,) = runtime.memory.channels[CONVERSATION_CHANNEL].items
    assert item.trust == "trusted_user"
    assert item.content == {
        "text": "比较图片",
        "media_refs": ("media:a", "media:b"),
    }


async def test_a_failing_job_surfaces_instead_of_dying_silently() -> None:
    """An exception raised by a spawned task must blow up run(), not just die quietly inside asyncio."""
    clock = VirtualClock()
    runtime = Runtime(clock=clock, memory=Memory(policies=SIM_POLICIES))

    async def broken() -> None:
        raise RuntimeError("仿真器炸了")

    runtime.spawn(broken(), lambda job_id, _result: ModelDone(slot="fast", job_id=job_id))

    with pytest.raises(RuntimeError, match="仿真器炸了"):
        await runtime.run()


async def test_job_result_is_handed_over_once_and_then_dropped() -> None:
    """Model output doesn't go into events or trace; the job table hands it over **once**, keyed by job_id (needed by on_done step 1).

    Once handed over, it's dropped: a `CallRecord` holds an entire ContextView, and
    leaving it in the table would pin the whole world every call ever saw in memory
    for good. Fetching it a second time is a bug -- better to blow up right there than
    read a stale view.
    """
    clock = VirtualClock()
    runtime = Runtime(clock=clock, memory=Memory(policies=SIM_POLICIES))

    async def model_call() -> CallRecord:
        await clock.sleep(0.2)
        return finished_call(text="两轴输出")

    job_id = runtime.spawn(
        model_call(), lambda job_id, _result: ModelDone(slot="fast", job_id=job_id)
    )

    await runtime.run()

    # The event carries only job_id; the payload itself doesn't ride along with the event.
    assert runtime.applied[0].job_id == job_id
    assert not hasattr(runtime.applied[0], "text")
    # The handoff really happened: that line was written back to the conversation
    # channel by `_consume`.
    spoken = runtime.memory.channels[CONVERSATION_CHANNEL].items
    assert [item.content["text"] for item in spoken] == ["两轴输出"]
    with pytest.raises(KeyError):
        runtime.result_of(job_id)
