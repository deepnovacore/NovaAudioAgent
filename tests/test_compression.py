from __future__ import annotations

import ast
from collections.abc import Sequence

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.memory import HandoffPolicy, Memory, MemoryItem
from nova_audio_agent.runtime import Runtime
from fakes import ScriptedCompressor
from repository_scan import python_nodes, repository_python_files


def _policy(name: str, watermark: int = 2) -> HandoffPolicy:
    return HandoffPolicy(
        channel=name,
        priority=10,
        wake="none",
        typical_latency=0,
        compress_watermark=watermark,
    )


def _append(runtime: Runtime, channel: str, value: int) -> MemoryItem:
    return runtime._append_memory(  # noqa: SLF001 - this pins the one runtime write path
        channel,
        ts=runtime.clock.now(),
        trust="trusted_system",
        priority=10,
        content={"value": value},
    )


def test_runtime_is_the_only_production_caller_of_memory_append() -> None:
    violations: list[str] = []
    for path in repository_python_files():
        if path.name == "runtime.py":
            continue
        for node in python_nodes(path):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "append"
                and isinstance(node.func.value, ast.Attribute)
                and node.func.value.attr == "memory"
            ):
                violations.append(f"{path}:{node.lineno}")

    assert violations == []


async def test_crossing_watermark_once_freezes_all_raw_items_and_writes_summary() -> None:
    clock = VirtualClock()
    compressor = ScriptedCompressor(clock=clock)
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=(_policy("alpha"),)),
        compressor=compressor,
    )
    first = _append(runtime, "alpha", 1)
    second = _append(runtime, "alpha", 2)
    raw_before = runtime.memory.channels["alpha"].items

    await runtime.run()

    channel = runtime.memory.channels["alpha"]
    assert compressor.compressed == [(first, second)]
    assert channel.summary == "摘要：2 条"
    assert channel.uncompressed == 0
    assert channel.items == raw_before


async def test_three_channels_crossing_together_are_not_lost_by_pending_merge() -> None:
    clock = VirtualClock()
    compressor = ScriptedCompressor(clock=clock)
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=(_policy("alpha"), _policy("beta"), _policy("gamma"))),
        compressor=compressor,
    )
    for channel in ("alpha", "beta", "gamma"):
        _append(runtime, channel, 1)
        _append(runtime, channel, 2)

    await runtime.run()

    assert [[item.channel for item in batch] for batch in compressor.compressed] == [
        ["alpha", "alpha"],
        ["beta", "beta"],
        ["gamma", "gamma"],
    ]
    assert all(
        runtime.memory.channels[channel].uncompressed == 0 for channel in ("alpha", "beta", "gamma")
    )


class _AppendingCompressor:
    def __init__(self) -> None:
        self.runtime: Runtime | None = None
        self.compressed: list[tuple[MemoryItem, ...]] = []

    async def compress(self, items: Sequence[MemoryItem]) -> str:
        self.compressed.append(tuple(items))
        if len(self.compressed) == 1:
            assert self.runtime is not None
            _append(self.runtime, "alpha", 3)
            _append(self.runtime, "alpha", 4)
        return f"full:{len(items)}"


async def test_items_appended_in_flight_remain_counted_and_requeue_when_still_over_line() -> None:
    clock = VirtualClock()
    compressor = _AppendingCompressor()
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=(_policy("alpha"),)),
        compressor=compressor,
    )
    compressor.runtime = runtime
    _append(runtime, "alpha", 1)
    _append(runtime, "alpha", 2)

    await runtime.run()

    channel = runtime.memory.channels["alpha"]
    assert [len(batch) for batch in compressor.compressed] == [2, 4]
    assert channel.summary == "full:4"
    assert channel.uncompressed == 0
    assert len(channel.items) == 4


async def test_backlog_drains_four_channels_with_an_in_flight_requeue() -> None:
    clock = VirtualClock()
    compressor = _AppendingCompressor()
    channels = ("alpha", "beta", "gamma", "delta")
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=tuple(_policy(channel) for channel in channels)),
        compressor=compressor,
    )
    compressor.runtime = runtime
    for channel in channels:
        _append(runtime, channel, 1)
        _append(runtime, channel, 2)

    await runtime.run()

    assert [[item.channel for item in batch] for batch in compressor.compressed] == [
        ["alpha", "alpha"],
        ["beta", "beta"],
        ["gamma", "gamma"],
        ["delta", "delta"],
        ["alpha", "alpha", "alpha", "alpha"],
    ]
    assert all(runtime.memory.channels[channel].uncompressed == 0 for channel in channels)


class _FailingThenWorkingCompressor:
    def __init__(self, *, empty: bool = False) -> None:
        self.calls = 0
        self.empty = empty

    async def compress(self, items: Sequence[MemoryItem]) -> str:
        self.calls += 1
        if self.calls == 1:
            if self.empty:
                return "   "
            raise RuntimeError("provider included sensitive detail")
        return f"recovered:{len(items)}"


async def test_failure_preserves_old_summary_count_and_raw_log_without_auto_retry() -> None:
    clock = VirtualClock()
    compressor = _FailingThenWorkingCompressor()
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=(_policy("alpha"),)),
        compressor=compressor,
    )
    channel = runtime.memory.channels["alpha"]
    channel.summary = "old"
    _append(runtime, "alpha", 1)
    _append(runtime, "alpha", 2)
    raw_before = channel.items

    await runtime.run()

    assert compressor.calls == 1
    assert channel.summary == "old"
    assert channel.uncompressed == 2
    assert channel.items == raw_before

    _append(runtime, "alpha", 3)
    await runtime.run()
    assert channel.summary == "recovered:3"
    assert channel.uncompressed == 0


async def test_empty_summary_has_the_same_non_destructive_failure_semantics() -> None:
    clock = VirtualClock()
    compressor = _FailingThenWorkingCompressor(empty=True)
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=(_policy("alpha"),)),
        compressor=compressor,
    )
    channel = runtime.memory.channels["alpha"]
    channel.summary = "old"
    _append(runtime, "alpha", 1)
    _append(runtime, "alpha", 2)

    await runtime.run()

    assert compressor.calls == 1
    assert channel.summary == "old"
    assert channel.uncompressed == 2
