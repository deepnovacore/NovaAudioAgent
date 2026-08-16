"""Event table completeness + the queue's deterministic ordering (Phase A green-light item 4).

Sort key = (ts, kind_rank, seq), where kind_rank only ever takes two values: deadline=1, everything
else 0. The rule that can be stated plainly is: **at the same virtual instant, deadline is processed
last** (it's the fallback for "nothing happened"), while all other events keep seq's FIFO order and
are never reordered relative to each other (R16).
"""

from __future__ import annotations

from nova_audio_agent.events import (
    EVENT_TYPES,
    Compress,
    CompressDone,
    Deadline,
    EventQueue,
    HandoffEvent,
    ModelDone,
    ObservationEvent,
    ProgressEvent,
    SpeakEnd,
    SpeakStart,
    UserInput,
)


def _handoff(delegate_id: str = "d-1") -> HandoffEvent:
    return HandoffEvent(
        channel="slow_sim",
        delegate_id=delegate_id,
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={"brightness": 30},
        refs=("slow_sim:1",),
    )


def test_event_table_covers_the_spine_table() -> None:
    """The current event table has ten rows/eleven kinds."""
    kinds = [event_type.KIND for event_type in EVENT_TYPES]

    assert kinds == [
        "user_input",
        "handoff",
        "progress",
        "observation",
        "deadline",
        "compress",
        "model_done",
        "compress_done",
        "speak_start",
        "speak_end",
        "assistant_spoken",
    ]
    assert len(set(kinds)) == len(kinds)


def test_push_stamps_ts_and_seq() -> None:
    queue = EventQueue()

    first = queue.push(UserInput(text="把客厅灯调暗点"), at=1.5)
    second = queue.push(Compress(channel="conversation"), at=1.5)

    assert (first.ts, first.seq) == (1.5, 1)
    assert (second.ts, second.seq) == (1.5, 2)
    assert first.text == "把客厅灯调暗点"  # positive twin: stamping must not drop the payload


def test_deadline_is_processed_last_within_the_same_instant() -> None:
    """R16: deadline is enqueued at the moment of dispatch (a low seq), so a plain (ts, seq)
    order would let it jump ahead of the handoff."""
    queue = EventQueue()
    queue.push(Deadline(delegate_id="d-1"), at=5.0)  # enqueued first
    queue.push(_handoff(), at=5.0)  # enqueued second, but must be processed first

    order = [event.KIND for event in _drain(queue, now=5.0)]

    assert order == ["handoff", "deadline"]


def test_non_deadline_kinds_keep_fifo_within_the_same_instant() -> None:
    """The narrow point of the two-value rank: kinds other than deadline are never reordered
    relative to each other."""
    queue = EventQueue()
    queue.push(_handoff(), at=2.0)
    queue.push(
        ObservationEvent(
            channel="watch",
            delegate_id="d-1",
            op="start",
            origin_ref="conversation:1",
            trust="untrusted_external",
            content={"state": "hit", "hit": True, "hit_count": 1},
        ),
        at=2.0,
    )
    queue.push(
        ProgressEvent(
            channel="slow_sim",
            delegate_id="d-1",
            op="run",
            phase="started",
            internal_activity=0,
            elapsed=0.0,
        ),
        at=2.0,
    )
    queue.push(UserInput(text="顺便，今晚看什么电影"), at=2.0)
    queue.push(ModelDone(slot="fast", job_id="job-1"), at=2.0)

    order = [event.KIND for event in _drain(queue, now=2.0)]

    assert order == ["handoff", "observation", "progress", "user_input", "model_done"]


def test_deadlines_among_themselves_keep_fifo() -> None:
    queue = EventQueue()
    queue.push(Deadline(delegate_id="d-1"), at=7.0)
    queue.push(Deadline(delegate_id="d-2"), at=7.0)

    order = [event.delegate_id for event in _drain(queue, now=7.0)]

    assert order == ["d-1", "d-2"]


def test_pop_ready_holds_back_future_events() -> None:
    queue = EventQueue()
    queue.push(SpeakStart(utterance_id="u-1", priority=100), at=0.0)
    queue.push(Deadline(delegate_id="d-1"), at=30.0)

    assert queue.pop_ready(0.0).KIND == "speak_start"  # due events come out
    assert queue.pop_ready(0.0) is None  # not-yet-due events don't
    assert queue.next_ts() == 30.0  # but it can still report the next advance target
    assert len(queue) == 1

    assert queue.pop_ready(30.0).KIND == "deadline"
    assert queue.next_ts() is None


def test_speak_events_and_compress_done_are_pushable() -> None:
    """Full type coverage: the kinds Phase A doesn't need yet must still be able to enqueue and
    dequeue, or "no-op for now" would be a lie."""
    queue = EventQueue()
    queue.push(CompressDone(channel="slow_sim", job_id="job-2"), at=0.0)
    queue.push(SpeakEnd(utterance_id="u-1"), at=0.0)

    assert [event.KIND for event in _drain(queue, now=0.0)] == ["compress_done", "speak_end"]


def _drain(queue: EventQueue, *, now: float) -> list:
    drained = []
    while (event := queue.pop_ready(now)) is not None:
        drained.append(event)
    return drained
