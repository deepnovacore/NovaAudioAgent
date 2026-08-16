from __future__ import annotations

from dataclasses import replace

import pytest

from nova_audio_agent.executors.sims import SlowSim
from nova_audio_agent.memory import HandoffPolicy
from nova_audio_agent.ports import ExecutorManifest, OpSpec
from nova_audio_agent.tool_schema import compile_tool_schema


POLICY = HandoffPolicy(
    channel="demo",
    priority=10,
    wake="fast",
    typical_latency=1.0,
    compress_watermark=20,
)


def _manifest(*ops: OpSpec, name: str = "demo") -> ExecutorManifest:
    return ExecutorManifest(name=name, ops=ops, policy=replace(POLICY, channel=name))


def _op(
    name: str,
    *,
    readonly: bool,
    params: dict[str, object] | None = None,
) -> OpSpec:
    return OpSpec(
        name=name,
        description=f"{name} description",
        params=params or {"type": "object", "properties": {}},
        readonly=readonly,
    )


def test_compiles_update_tools_and_one_wire_tool_per_manifest_op() -> None:
    compiled = compile_tool_schema((SlowSim().manifest,))

    names = [schema["function"]["name"] for schema in compiled.schemas]
    assert names == [
        "update_intent",
        "update_goal",
        "update_authorization",
        "slow_sim__set_light",
        "slow_sim__get_state",
    ]

    set_light = compiled.schemas[3]["function"]
    assert set_light["description"] == "设置指定房间的灯光亮度"
    assert set_light["parameters"]["properties"]["origin_ref"] == {
        "type": "string",
        "description": "当前 ContextView 中、这次动作所回答内容的 ref",
    }
    assert set(set_light["parameters"]["required"]) == {"room", "brightness", "origin_ref"}
    assert compiled.bindings["slow_sim__set_light"].logical_name == "slow_sim.set_light"
    assert compiled.bindings["slow_sim__set_light"].kind == "delegate"
    assert compiled.bindings["update_goal"].kind == "update"
    assert compiled.bindings["update_goal"].target == "goal"


def test_update_tools_are_partial_structured_state_writes_without_revision() -> None:
    compiled = compile_tool_schema((SlowSim().manifest,))
    intent = compiled.schemas[0]["function"]["parameters"]

    assert set(intent["properties"]) == {
        "objective_hypothesis",
        "constraints",
        "unresolved_questions",
        "uncertainty",
    }
    assert intent["additionalProperties"] is False
    assert intent["minProperties"] == 1
    assert "revision" not in intent["properties"]


def test_compiled_binding_carries_explicit_sync_result_contract() -> None:
    sync = OpSpec(
        name="status",
        description="status",
        params={"type": "object", "properties": {}},
        readonly=True,
        sync_result=True,
    )

    compiled = compile_tool_schema((_manifest(sync),))

    assert compiled.bindings["demo__status"].sync_result is True
    assert compiled.bindings["update_goal"].sync_result is False


def test_memory_recall_query_is_opt_in_and_has_no_origin_ref() -> None:
    plain = compile_tool_schema(())
    realtime = compile_tool_schema((), include_memory_recall=True)

    assert "memory__recall" not in plain.bindings
    binding = realtime.bindings["memory__recall"]
    assert binding.kind == "query"
    assert binding.logical_name == "memory.recall"
    assert binding.sync_result is False
    assert binding.executor is None
    schema = next(
        schema["function"]
        for schema in realtime.schemas
        if schema["function"]["name"] == "memory__recall"
    )
    params = schema["parameters"]
    assert params == {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512,
                "description": "用户当前问题中需要回想的事实或结果",
            },
            "scope": {
                "type": "string",
                "enum": ["recent", "any"],
                "description": "recent 优先最近记录；any 在当前会话记忆内扩大查找",
            },
        },
        "required": ["query", "scope"],
        "additionalProperties": False,
    }
    assert "origin_ref" not in params["properties"]


@pytest.mark.parametrize(
    ("manifest", "match"),
    [
        (
            _manifest(
                _op(
                    "probe",
                    readonly=True,
                    params={
                        "type": "object",
                        "properties": {"origin_ref": {"type": "string"}},
                    },
                )
            ),
            "origin_ref",
        ),
        (_manifest(_op("write", readonly=False)), "readonly"),
        (_manifest(_op("bad.name", readonly=True)), "字母、数字"),
        (_manifest(_op("x" * 60, readonly=True), name="executor"), "64"),
    ],
)
def test_rejects_manifests_that_cannot_be_compiled_safely(
    manifest: ExecutorManifest, match: str
) -> None:
    with pytest.raises(ValueError, match=match):
        compile_tool_schema((manifest,))


def test_rejects_duplicate_wire_names() -> None:
    first = _manifest(_op("read", readonly=True), name="same")
    second = _manifest(_op("read", readonly=True), name="same")

    with pytest.raises(ValueError, match="重复"):
        compile_tool_schema((first, second))
