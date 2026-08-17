"""Event-driven real-model acceptance demos for Stage C."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass

from openai import AsyncOpenAI

from nova_audio_agent.clock import RealClock
from nova_audio_agent.config import Settings
from nova_audio_agent.events import Deadline, Event, HandoffEvent, ModelDone, UserInput
from nova_audio_agent.executors.sims import SlowSim
from nova_audio_agent.memory import (
    CONVERSATION_CHANNEL,
    USER_PRIORITY,
    HandoffPolicy,
    Memory,
)
from nova_audio_agent.model_adapters import GatewayFastBrain, GatewaySurrogate
from nova_audio_agent.model_gateway import OpenAIModelGateway
from nova_audio_agent.ports import ExecutorAdapter
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.scorecard import FAILURE_WORDS, UNKNOWN_WORDS
from nova_audio_agent.speech import CliSpeechSink
from nova_audio_agent.tool_schema import compile_tool_schema

DemoWriter = Callable[[str], None]

_AMBIENT_POLICY = HandoffPolicy(
    channel="ambient",
    priority=10,
    wake="surrogate",
    typical_latency=1.0,
    compress_watermark=20,
)


@dataclass(frozen=True, slots=True)
class DemoResult:
    name: str
    passed: bool
    detail: str


class _Monitor:
    def __init__(self, runtime: Runtime, writer: DemoWriter) -> None:
        self.runtime = runtime
        self.writer = writer
        self.events: list[Event] = []
        self._queue: asyncio.Queue[Event] = asyncio.Queue()
        self._unmatched: list[Event] = []
        self._delegates: set[str] = set()
        runtime.observe(self._observe)

    def _observe(self, event: Event) -> None:
        self.events.append(event)
        self._queue.put_nowait(event)
        for delegate in self.runtime.delegates.snapshot():
            if delegate.delegate_id not in self._delegates:
                self._delegates.add(delegate.delegate_id)
                self.writer(
                    f"[dispatch {delegate.delegate_id} {delegate.executor}.{delegate.op}]\n"
                )
        if isinstance(event, HandoffEvent):
            label = "proactive" if event.delegate_id == "demo-ambient" else "handoff"
            self.writer(f"[{label} {event.delegate_id} {event.outcome}]\n")
        elif (
            isinstance(event, Deadline)
            and self.runtime.delegates.terminated_by(event.delegate_id) == "deadline"
        ):
            self.writer(f"[deadline {event.delegate_id} unknown]\n")

    async def wait(
        self,
        serving: asyncio.Task[None],
        predicate: Callable[[Event], bool],
    ) -> Event:
        while True:
            for index, event in enumerate(self._unmatched):
                if predicate(event):
                    return self._unmatched.pop(index)
            next_event = asyncio.create_task(self._queue.get())
            done, _pending = await asyncio.wait(
                (next_event, serving),
                return_when=asyncio.FIRST_COMPLETED,
            )
            if serving in done:
                next_event.cancel()
                await asyncio.gather(next_event, return_exceptions=True)
                await serving
                raise RuntimeError("runtime 意外停止")
            event = next_event.result()
            if predicate(event):
                return event
            self._unmatched.append(event)

    def index(self, target: Event) -> int:
        return next(index for index, event in enumerate(self.events) if event is target)


def _build(
    settings: Settings,
    *,
    executor: ExecutorAdapter,
    writer: DemoWriter,
    ambient: bool = False,
) -> Runtime:
    api_key = settings.require_api_key()
    clock = RealClock()
    gateway = OpenAIModelGateway(
        AsyncOpenAI(api_key=api_key, base_url=settings.model_base_url),
        clock=clock,
    )
    tools = compile_tool_schema((executor.manifest,))
    extra_policies = (_AMBIENT_POLICY,) if ambient else ()
    policies = (executor.manifest.policy, *extra_policies)
    return Runtime(
        clock=clock,
        memory=Memory(policies=policies),
        fastbrain=GatewayFastBrain(gateway, model=settings.fast_model, tools=tools),
        surrogate=GatewaySurrogate(gateway, model=settings.surrogate_model),
        executors={executor.manifest.name: executor},
        sink=CliSpeechSink(writer),
    )


def _spoken(runtime: Runtime) -> list[str]:
    return [
        str(item.content["text"])
        for item in runtime.memory.channels[CONVERSATION_CHANNEL].items
        if item.trust == "trusted_system" and isinstance(item.content.get("text"), str)
    ]


async def _stop(stop: asyncio.Event, serving: asyncio.Task[None]) -> None:
    stop.set()
    await serving


async def demo_async(settings: Settings, writer: DemoWriter) -> DemoResult:
    # Keep the executor below its 10-second deadline while leaving a real-model
    # second call enough room to finish. The driver still advances by events only.
    runtime = _build(settings, executor=SlowSim(latency=9.0), writer=writer)
    monitor = _Monitor(runtime, writer)
    stop = asyncio.Event()
    serving = asyncio.create_task(runtime.serve(stop))
    try:
        runtime.post(UserInput("把客厅灯调暗到 20%"))
        first_done = await monitor.wait(serving, lambda event: isinstance(event, ModelDone))
        delegates = runtime.delegates.snapshot()
        if not delegates:
            return DemoResult("async", False, "首轮真实模型没有 dispatch")
        delegate_id = delegates[0].delegate_id
        spoken_before = len(_spoken(runtime))
        runtime.post(UserInput("顺便推荐一部适合今晚看的科幻电影"))
        second_done = await monitor.wait(
            serving,
            lambda event: isinstance(event, ModelDone) and event is not first_done,
        )
        handoff = await monitor.wait(
            serving,
            lambda event: isinstance(event, HandoffEvent) and event.delegate_id == delegate_id,
        )
        new_speech = _spoken(runtime)[spoken_before:]
        passed = monitor.index(second_done) < monitor.index(handoff) and bool(new_speech)
        detail = (
            "第二条输入的回应早于首个 handoff"
            if passed
            else "第二条输入未在首个 handoff 前形成可见回应"
        )
        return DemoResult("async", passed, detail)
    finally:
        await _stop(stop, serving)


async def demo_dual_axis(settings: Settings, writer: DemoWriter) -> DemoResult:
    runtime = _build(settings, executor=SlowSim(latency=0.05), writer=writer)
    monitor = _Monitor(runtime, writer)
    stop = asyncio.Event()
    serving = asyncio.create_task(runtime.serve(stop))
    try:
        spoken_before = len(_spoken(runtime))
        runtime.post(UserInput("把客厅灯调暗到 20%，同时推荐一部今晚看的电影"))
        await monitor.wait(serving, lambda event: isinstance(event, ModelDone))
        delegates = runtime.delegates.snapshot()
        new_speech = _spoken(runtime)[spoken_before:]
        passed = bool(delegates and new_speech)
        if delegates:
            await monitor.wait(
                serving,
                lambda event: (
                    isinstance(event, HandoffEvent)
                    and event.delegate_id == delegates[0].delegate_id
                ),
            )
        return DemoResult(
            "dual-axis",
            passed,
            "同一 FastBrain call 同时输出文本与 dispatch"
            if passed
            else "首轮真实模型没有同时满足文本轴与动作轴",
        )
    finally:
        await _stop(stop, serving)


async def demo_timeout(settings: Settings, writer: DemoWriter) -> DemoResult:
    runtime = _build(
        settings,
        executor=SlowSim(inject="hang"),
        writer=writer,
    )
    monitor = _Monitor(runtime, writer)
    stop = asyncio.Event()
    serving = asyncio.create_task(runtime.serve(stop))
    try:
        runtime.post(UserInput("把客厅灯调暗到 20%"))
        first_done = await monitor.wait(serving, lambda event: isinstance(event, ModelDone))
        delegates = runtime.delegates.snapshot()
        if not delegates:
            return DemoResult("timeout", False, "首轮真实模型没有 dispatch")
        delegate_id = delegates[0].delegate_id
        deadline = await monitor.wait(
            serving,
            lambda event: (
                isinstance(event, Deadline)
                and event.delegate_id == delegate_id
                and runtime.delegates.terminated_by(delegate_id) == "deadline"
            ),
        )
        spoken_before = len(_spoken(runtime))
        await monitor.wait(
            serving,
            lambda event: (
                isinstance(event, ModelDone)
                and event is not first_done
                and monitor.index(event) > monitor.index(deadline)
            ),
        )
        text = "".join(_spoken(runtime)[spoken_before:])
        has_unknown = any(word in text for word in UNKNOWN_WORDS)
        has_failure = any(word in text for word in FAILURE_WORDS)
        passed = has_unknown and not has_failure
        return DemoResult(
            "timeout",
            passed,
            "deadline 后以不确定措辞回应" if passed else "deadline 后没有形成合约要求的不确定措辞",
        )
    finally:
        await _stop(stop, serving)


def _ambient_event() -> HandoffEvent:
    """Demo-only ambient envelope; it is deliberately not a production ingress API."""
    return HandoffEvent(
        channel="ambient",
        delegate_id="demo-ambient",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={"motion": "客厅持续有人活动，已达到用户要求的提醒条件"},
    )


async def demo_proactive(settings: Settings, writer: DemoWriter) -> DemoResult:
    runtime = _build(
        settings,
        executor=SlowSim(),
        writer=writer,
        ambient=True,
    )
    runtime._append_memory(  # noqa: SLF001 - demos must use the runtime's single write path
        CONVERSATION_CHANNEL,
        ts=runtime.clock.now(),
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "如果客厅持续有人活动，就提醒我"},
    )
    suggestion_text = "客厅持续有人活动，已达到用户要求的提醒条件"
    suggestion = runtime.suggestions.add(
        origin="fast_brain",
        kind="notify",
        content={"text": suggestion_text},
        evidence_refs=("ambient:1",),
    )
    monitor = _Monitor(runtime, writer)
    stop = asyncio.Event()
    serving = asyncio.create_task(runtime.serve(stop))
    try:
        spoken_before = len(_spoken(runtime))
        runtime.post(_ambient_event())
        watch_done = await monitor.wait(
            serving,
            lambda event: isinstance(event, ModelDone) and event.slot == "surrogate.watch",
        )
        if not runtime.slot_inflight("fast"):
            return DemoResult("proactive", False, "Surrogate 没有选择桌上的 suggestion")
        await monitor.wait(
            serving,
            lambda event: (
                isinstance(event, ModelDone) and event.slot == "fast" and event is not watch_done
            ),
        )
        speech = "".join(_spoken(runtime)[spoken_before:])
        fired = runtime.suggestions.get(suggestion.id)
        passed = bool(speech) and suggestion_text not in speech and fired is not None
        passed = passed and fired.status == "fired"
        return DemoResult(
            "proactive",
            passed,
            "Surrogate → FastBrain 两跳发言且未逐字复述 suggestion"
            if passed
            else "两跳发言、选择锁定或改写要求未满足",
        )
    finally:
        await _stop(stop, serving)


_DEMOS = {
    "async": demo_async,
    "dual-axis": demo_dual_axis,
    "timeout": demo_timeout,
    "proactive": demo_proactive,
}


async def run_demos(
    names: tuple[str, ...],
    *,
    settings: Settings,
    writer: DemoWriter,
) -> tuple[DemoResult, ...]:
    results: list[DemoResult] = []
    for name in names:
        writer(f"\n=== demo {name} ===\n")
        result = await _DEMOS[name](settings, writer)
        label = "通过" if result.passed else "场景未通过"
        writer(f"[{label}] {result.detail}\n")
        results.append(result)
    return tuple(results)
