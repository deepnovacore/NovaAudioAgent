from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import pytest

import nova_audio_agent.demos as demos
from nova_audio_agent.clock import RealClock
from nova_audio_agent.config import Settings
from nova_audio_agent.context_view import ContextView
from nova_audio_agent.executors.sims import SlowSim
from nova_audio_agent.memory import CONVERSATION_CHANNEL, Memory
from nova_audio_agent.ports import FastBrainDelta, SurrogateOutput, TextDelta
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.speech import CliSpeechSink


class _ExplicitNotificationSurrogate:
    async def watch(self, view: ContextView) -> SurrogateOutput:
        requests = [
            str(item.content.get("text", ""))
            for channel in view.channels
            if channel.name == CONVERSATION_CHANNEL
            for item in channel.recent
            if item.trust == "trusted_user"
        ]
        suggestions = tuple(item for item in view.affordances if item.source == "suggestion")
        explicitly_requested = any(
            "客厅持续有人活动" in request and "提醒我" in request for request in requests
        )
        if not explicitly_requested or not suggestions:
            return SurrogateOutput(speak=False, reason="没有明确的命中即提醒条件")
        return SurrogateOutput(
            speak=True,
            suggestion_id=suggestions[0].ref,
            reason="用户要求的提醒条件已命中",
        )


class _ParaphrasingFastBrain:
    async def call(self, _view: ContextView) -> AsyncIterator[FastBrainDelta]:
        await asyncio.sleep(0.01)
        yield TextDelta(text="客厅一直有动静，需要您看一下。")


@pytest.mark.asyncio
async def test_proactive_demo_uses_an_explicit_user_notification_condition(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    writer: list[str] = []
    executor = SlowSim()
    runtime = Runtime(
        clock=RealClock(),
        memory=Memory(policies=(executor.manifest.policy, demos._AMBIENT_POLICY)),
        fastbrain=_ParaphrasingFastBrain(),
        surrogate=_ExplicitNotificationSurrogate(),
        executors={executor.manifest.name: executor},
        sink=CliSpeechSink(writer.append),
    )
    monkeypatch.setattr(demos, "_build", lambda *_args, **_kwargs: runtime)

    result = await demos.demo_proactive(Settings(_env_file=None), writer.append)

    assert result.passed
    assert result.detail == "Surrogate → FastBrain 两跳发言且未逐字复述 suggestion"
