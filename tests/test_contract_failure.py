from __future__ import annotations

from collections.abc import AsyncIterator

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.context_view import ContextView
from nova_audio_agent.events import UserInput
from nova_audio_agent.memory import CONVERSATION_CHANNEL, Memory
from nova_audio_agent.ports import ContractFailureDelta, FastBrainDelta
from nova_audio_agent.runtime import Runtime


class _AlwaysMalformed:
    def __init__(self) -> None:
        self.calls = 0

    async def call(self, view: ContextView) -> AsyncIterator[FastBrainDelta]:
        self.calls += 1
        yield ContractFailureDelta(code="invalid_tool_arguments", tool_name="slow_sim__set_light")


async def test_contract_failure_is_recorded_and_compensated_at_most_once() -> None:
    brain = _AlwaysMalformed()
    runtime = Runtime(clock=VirtualClock(), memory=Memory(), fastbrain=brain)
    runtime.post(UserInput(text="把灯调暗"))

    await runtime.run()

    failures = [
        item
        for item in runtime.memory.channels[CONVERSATION_CHANNEL].items
        if item.content.get("error") == "model_contract_failure"
    ]
    assert brain.calls == 2
    assert len(failures) == 2
    assert failures[0].content == {
        "error": "model_contract_failure",
        "code": "invalid_tool_arguments",
        "tool_name": "slow_sim__set_light",
    }
