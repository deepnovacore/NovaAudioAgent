from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Callable

from fakes import SILENT, ScriptedCompressor, ScriptedFastBrain
from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.events import UserInput
from nova_audio_agent.executors.codex import (
    CODEX_POLICY,
    CodexAdapter,
    CodexAdapterDeadlineExceeded,
    CodexProcessStatus,
    CodexRunDeadline,
    CodexTransportResult,
)
from nova_audio_agent.executors.codex_jsonl import CodexJsonlParser
from nova_audio_agent.memory import Memory
from nova_audio_agent.ports import ActionOutput, DelegateRequest, FastBrainOutput, SpeakOutput
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.trace import TraceWriter


WORK_ORDER = "apply the bounded fixture change"
INTERNAL_SENTINELS = (
    "do-not-retain-thread-id",
    "do-not-retain-work-order",
    "do-not-retain-item-id",
    "do-not-retain-tool-name",
    "do-not-retain-token",
    "/do/not/retain/private/path",
    "do-not-retain-reasoning",
    "do-not-retain-command",
    "do-not-retain-output",
    "do-not-retain-final-message",
)


def _completed_result(
    *,
    events: list[dict[str, Any]] | None = None,
    internal_activity_count: int = 1,
) -> CodexTransportResult:
    text = "bounded completion evidence"
    return CodexTransportResult(
        classification="completed",
        code="completed",
        content={
            "events": events
            or [
                {"type": "thread.started"},
                {"type": "turn.started"},
                {"type": "internal_activity", "count": internal_activity_count},
                {"type": "turn.completed"},
            ],
            "protocol": {
                "thread_started": True,
                "turn_started": True,
                "terminal": "completed",
                "transport_closed": True,
                "unknown_event_count": 0,
            },
            "process": {"started": True, "exit_code": 0, "stop": "none"},
            "result": {
                "final_message": {
                    "text": text,
                    "original_chars": len(text),
                    "truncated": False,
                    "sha256": hashlib.sha256(text.encode()).hexdigest(),
                }
            },
        },
    )


class _ClockWorker:
    def __init__(self, clock: VirtualClock, *, latency: float) -> None:
        self.clock = clock
        self.latency = latency

    async def preflight(
        self,
        *,
        deadline: CodexRunDeadline | None = None,
    ) -> dict[str, Any]:
        return {
            "version": "0.145.0",
            "root_matches": True,
            "credential": {"present": True, "identity": "chatgpt"},
        }

    async def run(
        self,
        work_order: str,
        *,
        on_status: Callable[[CodexProcessStatus], None],
        deadline: CodexRunDeadline | None = None,
    ) -> CodexTransportResult:
        assert work_order == WORK_ORDER
        on_status(CodexProcessStatus(running=True, exited=False))
        remaining = float("inf") if deadline is None else deadline.remaining()
        await self.clock.sleep(min(self.latency, remaining))
        if self.latency >= remaining:
            raise CodexAdapterDeadlineExceeded
        on_status(
            CodexProcessStatus(
                running=False,
                exited=True,
                terminal="completed",
                exit_code=0,
            )
        )
        return _completed_result()


class _ParsedFixtureWorker(_ClockWorker):
    async def run(
        self,
        work_order: str,
        *,
        on_status: Callable[[CodexProcessStatus], None],
        deadline: CodexRunDeadline | None = None,
    ) -> CodexTransportResult:
        assert work_order == WORK_ORDER
        on_status(CodexProcessStatus(running=True, exited=False))
        parser = CodexJsonlParser()
        fixture = Path(__file__).parent / "fixtures" / "codex" / "malicious-items.jsonl"
        for line in fixture.read_bytes().splitlines(keepends=True):
            parser.feed(line)
        summary = parser.close()
        await self.clock.sleep(self.latency)
        on_status(
            CodexProcessStatus(
                running=False,
                exited=True,
                terminal="completed",
                exit_code=0,
            )
        )
        return _completed_result(
            events=[dict(event) for event in summary.events],
            internal_activity_count=summary.internal_activity_count,
        )


def _delegate() -> DelegateRequest:
    return DelegateRequest(
        executor="codex",
        op="run",
        request={"work_order": WORK_ORDER},
        origin_ref="conversation:1",
    )


def _dispatch_output() -> FastBrainOutput:
    return FastBrainOutput(
        speak=SpeakOutput(act="none"),
        action=ActionOutput(act="delegate", delegate=_delegate()),
    )


def _runtime(
    clock: VirtualClock,
    worker: _ClockWorker,
    *,
    replies: list[FastBrainOutput] | None = None,
    compressor: ScriptedCompressor | None = None,
    trace: TraceWriter | None = None,
) -> tuple[Runtime, ScriptedFastBrain]:
    brain = ScriptedFastBrain(
        [_dispatch_output(), *(replies or [])],
        clock=clock,
        latency=0.0,
    )
    adapter = CodexAdapter(worker)
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=(CODEX_POLICY,)),
        fastbrain=brain,
        compressor=compressor,
        executors={"codex": adapter},
        trace=trace,
    )
    return runtime, brain


async def test_codex_runtime_redacts_work_order_from_timeout_evidence_and_probe(
    tmp_path: Path,
) -> None:
    clock = VirtualClock()
    trace_path = tmp_path / "deadline-trace.jsonl"
    with TraceWriter(trace_path) as trace:
        runtime, brain = _runtime(
            clock,
            _ClockWorker(clock, latency=float("inf")),
            replies=[SILENT, SILENT],
            trace=trace,
        )
        runtime.post(UserInput(text="implement the bounded task"))
        runtime.post(UserInput(text="is it still running?"), delay=1.0)

        await runtime.run()

    in_flight = brain.views[1].in_flight
    assert len(in_flight) == 1
    assert in_flight[0].dispatched_at == 0.0
    assert in_flight[0].eta == 180.0
    assert in_flight[0].deadline == 600.0
    assert runtime.delegates.snapshot() == ()
    assert runtime.delegates.terminated_by("d-1") == "handoff"
    observation = runtime.memory.channels["codex"].items[0]
    assert observation.outcome == "unknown"
    assert observation.content["code"] == "adapter_timeout"
    assert "request" not in observation.content
    probes = [
        item
        for item in brain.views[2].affordances
        if item.source == "probe" and item.content["op"] == "status"
    ]
    assert len(probes) == 1
    assert probes[0].conclusive is False
    assert probes[0].content["unknown"]["code"] == "adapter_timeout"
    assert "request" not in probes[0].content["unknown"]
    retained = repr(runtime.memory.channels["codex"].items)
    trace_text = trace_path.read_text(encoding="utf-8")
    assert WORK_ORDER not in retained
    assert WORK_ORDER not in trace_text


async def test_adapter_deadline_preempts_runtime_deadline_without_late_handoff() -> None:
    clock = VirtualClock()
    runtime, _brain = _runtime(clock, _ClockWorker(clock, latency=610.0))
    runtime.post(UserInput(text="implement the bounded task"))

    await runtime.run()

    channel = runtime.memory.channels["codex"]
    assert [(item.ts, item.outcome) for item in channel.items] == [(540.0, "unknown")]
    assert channel.items[0].content["code"] == "adapter_timeout"
    assert runtime.delegates.snapshot() == ()
    assert runtime.delegates.terminated_by("d-1") == "handoff"
    assert [event.KIND for event in runtime.applied].count("deadline") == 1


async def test_five_codex_observations_cross_the_manifest_watermark_without_real_wait() -> None:
    clock = VirtualClock()
    compressor = ScriptedCompressor(clock=clock)
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=(CODEX_POLICY,)),
        compressor=compressor,
    )
    for index in range(5):
        runtime._append_memory(  # noqa: SLF001 - pins the Runtime's sole write path
            "codex",
            ts=clock.now(),
            trust="untrusted_external",
            priority=CODEX_POLICY.priority,
            content={"events": [{"type": "internal_activity", "count": index + 1}]},
            outcome="ok",
        )

    await runtime.run()

    channel = runtime.memory.channels["codex"]
    assert len(compressor.compressed) == 1
    assert len(compressor.compressed[0]) == CODEX_POLICY.compress_watermark == 5
    assert channel.summary == "摘要：5 条"
    assert channel.uncompressed == 0
    assert clock.now() == 0.05


async def test_codex_internal_items_never_enter_memory_or_the_jsonl_trace(tmp_path: Path) -> None:
    clock = VirtualClock()
    trace_path = tmp_path / "trace.jsonl"
    with TraceWriter(trace_path) as trace:
        runtime, _brain = _runtime(
            clock,
            _ParsedFixtureWorker(clock, latency=1.0),
            trace=trace,
        )
        runtime.post(UserInput(text="implement the bounded task"))
        await runtime.run()

    retained = repr(runtime.memory.channels["codex"].items)
    trace_text = trace_path.read_text(encoding="utf-8")
    for sentinel in INTERNAL_SENTINELS:
        assert sentinel not in retained
        assert sentinel not in trace_text
    observation = runtime.memory.channels["codex"].items[0]
    assert {"type": "internal_activity", "count": 3} in observation.content["events"]
    assert '"type": "internal_activity"' in trace_text
