from __future__ import annotations

from collections.abc import AsyncIterator, Sequence

from nova_audio_agent.context_view import ContextView, compile_context_view
from nova_audio_agent.executors.codex_live import CODEX_LIVE_MANIFEST
from nova_audio_agent.executors.sims import SlowSim
from nova_audio_agent.memory import CONVERSATION_CHANNEL, Memory, MemoryItem
from nova_audio_agent.media import MediaStore
from nova_audio_agent.model_adapters import GatewayCompressor, GatewayFastBrain, GatewaySurrogate
from nova_audio_agent.model_gateway import (
    GatewayCompletion,
    GatewayDelta,
    GatewayImage,
    GatewayTextDelta,
    GatewayToolCallDelta,
)
from nova_audio_agent.ports import (
    ActionDelta,
    ContractFailureDelta,
    SpeakActDelta,
    TextDelta,
)
from nova_audio_agent.tool_schema import compile_tool_schema


class _Gateway:
    def __init__(
        self,
        *,
        deltas: Sequence[GatewayDelta] = (),
        completion: str = "",
    ) -> None:
        self.deltas = tuple(deltas)
        self.completion = completion
        self.stream_prompts: list[str] = []
        self.stream_tools: list[tuple[str, ...]] = []
        self.stream_images: list[tuple[GatewayImage, ...]] = []
        self.complete_prompts: list[str] = []

    async def stream(
        self,
        *,
        model: str,
        system: str,
        prompt: str,
        tools: Sequence[dict[str, object]] = (),
        images: Sequence[GatewayImage] = (),
    ) -> AsyncIterator[GatewayDelta]:
        self.stream_prompts.append(prompt)
        self.stream_tools.append(tuple(str(item["function"]["name"]) for item in tools))
        self.stream_images.append(tuple(images))
        for delta in self.deltas:
            yield delta

    async def complete(
        self,
        *,
        model: str,
        system: str,
        prompt: str,
        json_schema: dict[str, object] | None = None,
    ) -> GatewayCompletion:
        self.complete_prompts.append(prompt)
        return GatewayCompletion(text=self.completion)


def _view() -> ContextView:
    memory = Memory()
    memory.append(
        CONVERSATION_CHANNEL,
        ts=0.0,
        trust="trusted_user",
        priority=100,
        content={"text": "把客厅灯调暗"},
    )
    return compile_context_view(memory, floor="idle", now=0.0)


async def test_fastbrain_forwards_text_and_reassembles_a_delegate_tool_call() -> None:
    gateway = _Gateway(
        deltas=(
            GatewayTextDelta("好的，"),
            GatewayTextDelta("我来调。"),
            GatewayToolCallDelta(index=0, name="slow_sim__", arguments='{"room":"客厅",'),
            GatewayToolCallDelta(
                index=0,
                name="set_light",
                arguments='"brightness":30,"origin_ref":"conversation:1"}',
            ),
        )
    )
    brain = GatewayFastBrain(
        gateway,
        model="qwen-max",
        tools=compile_tool_schema((SlowSim().manifest,)),
    )

    deltas = [delta async for delta in brain.call(_view())]

    assert [delta.text for delta in deltas if isinstance(delta, TextDelta)] == [
        "好的，",
        "我来调。",
    ]
    (action,) = [delta.action for delta in deltas if isinstance(delta, ActionDelta)]
    assert action.act == "delegate"
    assert action.delegate is not None
    assert action.delegate.executor == "slow_sim"
    assert action.delegate.op == "set_light"
    assert action.delegate.origin_ref == "conversation:1"
    assert action.delegate.request == {"room": "客厅", "brightness": 30}


async def test_fastbrain_materializes_images_and_renders_explicit_visibility_states() -> None:
    ids = iter(("attached", "resident"))
    store = MediaStore(max_bytes=4, id_factory=lambda: next(ids))
    evicted = store.put(
        b"aa",
        media_type="image/jpeg",
        width=10,
        height=10,
        captured_at=1.0,
    )
    resident = store.put(
        b"bbbb",
        media_type="image/png",
        width=20,
        height=20,
        captured_at=2.0,
    )
    assert store.peek(evicted.ref) is None
    memory = Memory()
    memory.append(
        CONVERSATION_CHANNEL,
        ts=0.0,
        trust="trusted_user",
        priority=100,
        content={"text": "看图", "media_refs": (evicted.ref, resident.ref)},
    )
    gateway = _Gateway()
    brain = GatewayFastBrain(
        gateway,
        model="qwen3-vl-plus",
        tools=compile_tool_schema((SlowSim().manifest,)),
        media_store=store,
    )

    deltas = [
        delta async for delta in brain.call(compile_context_view(memory, floor="idle", now=2.0))
    ]

    assert deltas == []
    assert gateway.stream_images == [(GatewayImage(resident.ref, "image/png", b"bbbb"),)]
    assert f"{resident.ref}：图片就在你眼前" in gateway.stream_prompts[0]
    assert f"{evicted.ref}：图片已不可用" in gateway.stream_prompts[0]


async def test_fastbrain_decodes_a_structured_update() -> None:
    gateway = _Gateway(
        deltas=(
            GatewayToolCallDelta(
                index=0,
                name="update_intent",
                arguments='{"objective_hypothesis":"调暗客厅灯","uncertainty":0.1}',
            ),
        )
    )
    brain = GatewayFastBrain(
        gateway,
        model="qwen-max",
        tools=compile_tool_schema((SlowSim().manifest,)),
    )

    deltas = [delta async for delta in brain.call(_view())]

    (action,) = [delta.action for delta in deltas if isinstance(delta, ActionDelta)]
    assert action.act == "update"
    assert action.update is not None
    assert action.update.target == "intent"
    assert action.update.delta == {
        "objective_hypothesis": "调暗客厅灯",
        "uncertainty": 0.1,
    }


async def test_live_non_user_wake_structurally_hides_codex_control_tools() -> None:
    gateway = _Gateway(
        deltas=(
            GatewayToolCallDelta(
                index=0,
                name="codex__steer",
                arguments='{"instruction":"duplicate","origin_ref":"conversation:1"}',
            ),
        )
    )
    brain = GatewayFastBrain(
        gateway,
        model="qwen-max",
        tools=compile_tool_schema((CODEX_LIVE_MANIFEST,)),
        include_trigger=True,
    )
    memory = Memory()
    memory.append(
        CONVERSATION_CHANNEL,
        ts=0.0,
        trust="trusted_user",
        priority=100,
        content={"text": "历史 steering 请求"},
    )
    view = compile_context_view(
        memory,
        floor="idle",
        now=1.0,
        trigger_kind="handoff",
    )

    deltas = [delta async for delta in brain.call(view)]

    assert not any(name.startswith("codex__") for name in gateway.stream_tools[0])
    assert deltas == [ContractFailureDelta(code="unknown_tool", tool_name="codex__steer")]


async def test_live_user_input_keeps_codex_control_tools_available() -> None:
    gateway = _Gateway()
    brain = GatewayFastBrain(
        gateway,
        model="qwen-max",
        tools=compile_tool_schema((CODEX_LIVE_MANIFEST,)),
        include_trigger=True,
    )
    view = compile_context_view(
        Memory(),
        floor="idle",
        now=1.0,
        trigger_kind="user_input",
    )

    assert [delta async for delta in brain.call(view)] == []

    assert {"codex__run", "codex__steer", "codex__status"}.issubset(gateway.stream_tools[0])


async def test_bad_tool_json_becomes_a_contract_failure_without_echoing_arguments() -> None:
    gateway = _Gateway(
        deltas=(
            GatewayToolCallDelta(
                index=0,
                name="slow_sim__set_light",
                arguments='{"api_key":"do-not-copy"',
            ),
        )
    )
    brain = GatewayFastBrain(
        gateway,
        model="qwen-max",
        tools=compile_tool_schema((SlowSim().manifest,)),
    )

    deltas = [delta async for delta in brain.call(_view())]

    assert deltas == [
        ContractFailureDelta(code="invalid_tool_arguments", tool_name="slow_sim__set_light")
    ]
    assert "do-not-copy" not in repr(deltas)


async def test_missing_origin_ref_is_a_contract_failure() -> None:
    gateway = _Gateway(
        deltas=(
            GatewayToolCallDelta(
                index=0,
                name="slow_sim__get_state",
                arguments='{"room":"客厅"}',
            ),
        )
    )
    brain = GatewayFastBrain(
        gateway,
        model="qwen-max",
        tools=compile_tool_schema((SlowSim().manifest,)),
    )

    assert [delta async for delta in brain.call(_view())] == [
        ContractFailureDelta(code="missing_origin_ref", tool_name="slow_sim__get_state")
    ]


async def test_surrogate_and_compressor_keep_their_ports_narrow() -> None:
    surrogate_gateway = _Gateway(
        completion='{"speak":true,"suggestion_id":"s-2","reason":"需要提醒"}'
    )
    surrogate = GatewaySurrogate(surrogate_gateway, model="qwen-flash")

    decision = await surrogate.watch(_view())

    assert decision.speak is True
    assert decision.suggestion_id == "s-2"
    assert not any(isinstance(item, SpeakActDelta) for item in ())

    compressor_gateway = _Gateway(completion="用户要求调暗客厅灯，结果仍未返回。")
    compressor = GatewayCompressor(compressor_gateway, model="qwen-flash")
    item = MemoryItem(
        channel="conversation",
        seq=1,
        ts=0.0,
        trust="trusted_user",
        priority=100,
        content={"text": "调暗客厅灯"},
    )
    assert await compressor.compress((item,)) == "用户要求调暗客厅灯，结果仍未返回。"
