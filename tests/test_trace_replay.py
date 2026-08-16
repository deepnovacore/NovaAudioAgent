"""Trace replay isomorphism (stage A green item 1).

The JSONL event log **is** the trace (D14). Replaying it should reproduce the same sequence of
events — equal item by item, including ts and seq.

Asserting "equal" alone isn't enough: an empty sequence equals an empty sequence too. So it's
paired with a positive twin — feed a fixed script and pin down the length, the kind sequence, and
(ts, seq) exactly. That non-contiguous seq sequence (1, 3, 4, 2) is itself a fingerprint of the
ordering discipline: the deadline is enqueued at dispatch time so it gets a lower seq, yet
kind_rank places it after the handoff that lands at the same instant.
"""

from __future__ import annotations

import json
from pathlib import Path

from fakes import finished_call
from nova_audio_agent.calls import CallRecord
from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.events import (
    Deadline,
    HandoffEvent,
    ModelDone,
    ObservationEvent,
    ProgressEvent,
    UserInput,
)
from nova_audio_agent.memory import Memory
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.trace import TraceWriter, replay
from policies import SIM_POLICIES


def _fixed_script(runtime: Runtime, clock: VirtualClock) -> None:
    """A fixed script: one user input, one fast-model call, one 5-second slow job plus its deadline."""
    runtime.post(UserInput(text="把客厅灯调暗点"))
    runtime.post(Deadline(delegate_id="d-1"), delay=5.0)

    async def model_call() -> CallRecord:
        await clock.sleep(0.5)
        return finished_call(text="说点什么")

    async def slow_dispatch() -> dict[str, int]:
        await clock.sleep(5.0)
        return {"brightness": 30}

    runtime.spawn(model_call(), lambda job_id, _result: ModelDone(slot="fast", job_id=job_id))
    runtime.spawn(
        slow_dispatch(),
        lambda _job_id, result: HandoffEvent(
            channel="slow_sim",
            delegate_id="d-1",
            origin_ref="conversation:1",
            outcome="ok",
            trust="trusted_system",
            content=result,
            refs=("slow_sim:1",),
        ),
    )


async def test_replay_reproduces_the_live_event_sequence(tmp_path: Path) -> None:
    path = tmp_path / "trace.jsonl"
    clock = VirtualClock()
    with TraceWriter(path) as trace:
        runtime = Runtime(clock=clock, memory=Memory(policies=SIM_POLICIES), trace=trace)
        _fixed_script(runtime, clock)
        await runtime.run()

    assert replay(path) == runtime.applied

    # Positive twin: contents are pinned down, otherwise "empty sequence == empty sequence" would also pass.
    assert [event.KIND for event in runtime.applied] == [
        "user_input",
        "model_done",
        "handoff",
        "deadline",
    ]
    assert [event.ts for event in runtime.applied] == [0.0, 0.5, 5.0, 5.0]
    assert [event.seq for event in runtime.applied] == [1, 3, 4, 2]


async def test_trace_carries_the_payload_but_not_the_model_output(tmp_path: Path) -> None:
    """04-ports.md hygiene: the log doesn't store the raw prompt. The model output stays in the job table, not in the trace."""
    path = tmp_path / "trace.jsonl"
    clock = VirtualClock()
    with TraceWriter(path) as trace:
        runtime = Runtime(clock=clock, memory=Memory(policies=SIM_POLICIES), trace=trace)
        _fixed_script(runtime, clock)
        await runtime.run()

    records = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    by_kind = {record["kind"]: record for record in records}

    assert by_kind["model_done"]["payload"] == {"slot": "fast", "job_id": "job-1"}
    assert "说点什么" not in path.read_text(encoding="utf-8")
    # Positive twin: executor observations are part of memory, and they must land in the trace verbatim
    # (D14's channel is the trace).
    assert by_kind["handoff"]["payload"]["content"] == {"brightness": 30}
    assert by_kind["handoff"]["payload"]["refs"] == ["slow_sim:1"]


async def test_replay_of_an_empty_trace_is_empty(tmp_path: Path) -> None:
    path = tmp_path / "trace.jsonl"
    path.write_text("", encoding="utf-8")

    assert replay(path) == []


def test_replay_really_parses_the_file(tmp_path: Path) -> None:
    """Feed it a **hand-written** JSONL file: prove replay reads from the file, not from some
    in-process cache.

    Without this, an implementation that "stores the events written via write() in an in-process
    list and returns it keyed by path" could also make "replay == the live run's sequence" pass
    fully green — and that kind of replay would be useless.
    """
    path = tmp_path / "hand-written.jsonl"
    path.write_text(
        '{"kind": "user_input", "payload": {"text": "手写的一行"}, "seq": 1, "ts": 0.0}\n'
        '{"kind": "handoff", "payload": {"channel": "slow_sim", "content": {"brightness": 30},'
        ' "delegate_id": "d-1", "origin_ref": "conversation:1", "outcome": "unknown",'
        ' "refs": ["slow_sim:1"], "trust": "trusted_system"}, "seq": 2, "ts": 5.0}\n',
        encoding="utf-8",
    )

    assert replay(path) == [
        UserInput(text="手写的一行", ts=0.0, seq=1),
        HandoffEvent(
            channel="slow_sim",
            delegate_id="d-1",
            origin_ref="conversation:1",
            outcome="unknown",
            trust="trusted_system",
            content={"brightness": 30},
            refs=("slow_sim:1",),
            ts=5.0,
            seq=2,
        ),
    ]


def test_user_input_media_refs_survive_trace_round_trip_without_payload(tmp_path: Path) -> None:
    path = tmp_path / "trace.jsonl"
    event = UserInput(
        text="比较图片",
        media_refs=("media:a", "media:b"),
        ts=1.0,
        seq=1,
    )

    with TraceWriter(path) as trace:
        trace.write(event)

    assert replay(path) == [event]
    text = path.read_text(encoding="utf-8")
    assert '"media_refs": ["media:a", "media:b"]' in text
    assert "data:image" not in text


def test_progress_survives_trace_round_trip(tmp_path: Path) -> None:
    path = tmp_path / "trace.jsonl"
    event = ProgressEvent(
        channel="codex",
        delegate_id="d-7",
        op="run",
        phase="working",
        internal_activity=3,
        elapsed=31.5,
        ts=32.0,
        seq=8,
    )

    with TraceWriter(path) as trace:
        trace.write(event)

    assert replay(path) == [event]
    assert json.loads(path.read_text(encoding="utf-8"))["payload"] == {
        "channel": "codex",
        "delegate_id": "d-7",
        "elapsed": 31.5,
        "internal_activity": 3,
        "op": "run",
        "phase": "working",
        "summary": None,
    }


def test_progress_summary_survives_trace_round_trip(tmp_path: Path) -> None:
    path = tmp_path / "trace.jsonl"
    event = ProgressEvent(
        channel="codex",
        delegate_id="d-7",
        op="run",
        phase="working",
        internal_activity=3,
        elapsed=31.5,
        summary="已执行 3 条命令。正在实现方块旋转",
        ts=32.0,
        seq=8,
    )

    with TraceWriter(path) as trace:
        trace.write(event)

    assert replay(path) == [event]
    payload = json.loads(path.read_text(encoding="utf-8"))["payload"]
    assert payload["summary"] == "已执行 3 条命令。正在实现方块旋转"


def test_observation_survives_trace_round_trip(tmp_path: Path) -> None:
    path = tmp_path / "trace.jsonl"
    event = ObservationEvent(
        channel="watch",
        delegate_id="d-7",
        op="start",
        origin_ref="conversation:1",
        trust="untrusted_external",
        content={"state": "hit", "hit": True, "coords": (1, 2), "hit_count": 1},
        refs=("media:1",),
        ts=32.0,
        seq=8,
    )

    with TraceWriter(path) as trace:
        trace.write(event)

    assert replay(path) == [event]
    assert event.content["coords"] == [1, 2]
    assert json.loads(path.read_text(encoding="utf-8"))["payload"] == {
        "channel": "watch",
        "content": {
            "coords": [1, 2],
            "hit": True,
            "hit_count": 1,
            "state": "hit",
        },
        "delegate_id": "d-7",
        "op": "start",
        "origin_ref": "conversation:1",
        "refs": ["media:1"],
        "trust": "untrusted_external",
    }


def test_old_progress_payload_without_summary_still_loads(tmp_path: Path) -> None:
    """Pre-R103 traces have no summary key; replay must not require it."""
    path = tmp_path / "hand-written.jsonl"
    path.write_text(
        '{"kind": "progress", "payload": {"channel": "codex", "delegate_id": "d-7",'
        ' "op": "run", "phase": "working", "internal_activity": 3, "elapsed": 31.5},'
        ' "seq": 8, "ts": 32.0}\n',
        encoding="utf-8",
    )

    assert replay(path) == [
        ProgressEvent(
            channel="codex",
            delegate_id="d-7",
            op="run",
            phase="working",
            internal_activity=3,
            elapsed=31.5,
            ts=32.0,
            seq=8,
        )
    ]


def test_nested_tuples_in_content_survive_the_json_round_trip(tmp_path: Path) -> None:
    """An executor casually hands over a tuple; that shouldn't break the "equal item by item" green item."""
    path = tmp_path / "trace.jsonl"
    event = HandoffEvent(
        channel="slow_sim",
        delegate_id="d-1",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={"coords": (1, 2), "nested": {"tags": ("a", "b")}},
        ts=1.0,
        seq=1,
    )
    with TraceWriter(path) as trace:
        trace.write(event)

    assert replay(path) == [event]
    assert event.content == {"coords": [1, 2], "nested": {"tags": ["a", "b"]}}


def test_one_trace_file_is_one_run(tmp_path: Path) -> None:
    """Reusing the same path must not mix in events from the previous run — otherwise the replay
    wouldn't be this run's trace."""
    path = tmp_path / "trace.jsonl"
    with TraceWriter(path) as first:
        first.write(UserInput(text="上一次", ts=0.0, seq=1))
    with TraceWriter(path) as second:
        second.write(Deadline(delegate_id="d-1", ts=1.0, seq=1))

    assert replay(path) == [Deadline(delegate_id="d-1", ts=1.0, seq=1)]
