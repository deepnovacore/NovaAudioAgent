"""Compile executor manifests into provider-safe function schemas.

The logical tool name remains ``<executor>.<op>``. DashScope's OpenAI-compatible
wire format does not permit dots, so the provider sees ``<executor>__<op>`` and
the immutable binding table restores the logical identity.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Literal, Mapping, Sequence

from nova_audio_agent.ports import ExecutorManifest, OpSpec

_WIRE_PART = re.compile(r"^[A-Za-z0-9_-]+$")
_ORIGIN_REF = {
    "type": "string",
    "description": "当前 ContextView 中、这次动作所回答内容的 ref",
}


@dataclass(frozen=True, slots=True)
class ToolBinding:
    kind: Literal["delegate", "update", "query"]
    logical_name: str
    executor: str | None = None
    op: str | None = None
    target: Literal["intent", "goal", "authorization"] | None = None
    sync_result: bool = False


@dataclass(frozen=True, slots=True)
class CompiledTools:
    schemas: tuple[dict[str, Any], ...]
    bindings: Mapping[str, ToolBinding]


_UPDATE_PROPERTIES: dict[str, dict[str, dict[str, Any]]] = {
    "intent": {
        "objective_hypothesis": {"type": "string"},
        "constraints": {"type": "array", "items": {"type": "string"}},
        "unresolved_questions": {"type": "array", "items": {"type": "string"}},
        "uncertainty": {"type": "number"},
    },
    "goal": {
        "objective": {"type": "string"},
        "acceptance_criteria": {"type": "array", "items": {"type": "string"}},
        "status": {"type": "string", "enum": ["accepted", "superseded"]},
    },
    "authorization": {
        "allow": {"type": "array", "items": {"type": "string"}},
        "deny": {"type": "array", "items": {"type": "string"}},
        "evidence_refs": {"type": "array", "items": {"type": "string"}},
    },
}


def compile_tool_schema(
    manifests: Sequence[ExecutorManifest],
    *,
    include_memory_recall: bool = False,
) -> CompiledTools:
    schemas: list[dict[str, Any]] = []
    bindings: dict[str, ToolBinding] = {}

    for target in ("intent", "goal", "authorization"):
        wire_name = f"update_{target}"
        schemas.append(
            _function_schema(
                wire_name,
                f"按字段更新 {target}；只传本轮确实变化的字段",
                {
                    "type": "object",
                    "properties": copy.deepcopy(_UPDATE_PROPERTIES[target]),
                    "additionalProperties": False,
                    "minProperties": 1,
                },
            )
        )
        bindings[wire_name] = ToolBinding(
            kind="update",
            logical_name=f"update.{target}",
            target=target,  # type: ignore[arg-type]
        )

    if include_memory_recall:
        wire_name = "memory__recall"
        schemas.append(
            _function_schema(
                wire_name,
                "从当前会话的历史记忆中查找与用户问题相关的证据",
                {
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
                            "description": ("recent 优先最近记录；any 在当前会话记忆内扩大查找"),
                        },
                    },
                    "required": ["query", "scope"],
                    "additionalProperties": False,
                },
            )
        )
        bindings[wire_name] = ToolBinding(
            kind="query",
            logical_name="memory.recall",
        )

    seen_manifests: set[str] = set()
    for manifest in manifests:
        if manifest.name in seen_manifests:
            raise ValueError(f"manifest 名称重复：{manifest.name}")
        seen_manifests.add(manifest.name)
        _validate_part(manifest.name, label="executor")
        if not any(op.readonly for op in manifest.ops):
            raise ValueError(f"manifest {manifest.name!r} 至少需要一个 readonly op")
        for op in manifest.ops:
            wire_name, schema, binding = _compile_op(manifest, op)
            if wire_name in bindings:
                raise ValueError(f"工具 wire name 重复：{wire_name}")
            schemas.append(schema)
            bindings[wire_name] = binding

    return CompiledTools(
        schemas=tuple(schemas),
        bindings=MappingProxyType(bindings),
    )


def _compile_op(manifest: ExecutorManifest, op: OpSpec) -> tuple[str, dict[str, Any], ToolBinding]:
    _validate_part(op.name, label="op")
    wire_name = f"{manifest.name}__{op.name}"
    if len(wire_name) > 64:
        raise ValueError(f"工具 wire name 超过 64 个字符：{wire_name}")
    if not op.description.strip():
        raise ValueError(f"{manifest.name}.{op.name} 缺 description")

    parameters = copy.deepcopy(op.params)
    if parameters.get("type") != "object" or not isinstance(parameters.get("properties"), dict):
        raise ValueError(f"{manifest.name}.{op.name} 的 params 必须是 object JSON Schema")
    properties = parameters["properties"]
    if "origin_ref" in properties:
        raise ValueError(f"{manifest.name}.{op.name} 的 params 保留字冲突：origin_ref")
    required = list(parameters.get("required", ()))
    host_handled_confirmation = manifest.name == "codex" and op.name == "confirm_project_action"
    if not host_handled_confirmation:
        properties["origin_ref"] = dict(_ORIGIN_REF)
        if "origin_ref" not in required:
            required.append("origin_ref")
    parameters["required"] = required
    parameters.setdefault("additionalProperties", False)

    return (
        wire_name,
        _function_schema(wire_name, op.description, parameters),
        ToolBinding(
            kind="delegate",
            logical_name=f"{manifest.name}.{op.name}",
            executor=manifest.name,
            op=op.name,
            sync_result=op.sync_result,
        ),
    )


def _validate_part(value: str, *, label: str) -> None:
    if not value or _WIRE_PART.fullmatch(value) is None:
        raise ValueError(f"{label} 名称只能包含字母、数字、下划线和短划线：{value!r}")


def _function_schema(name: str, description: str, parameters: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": parameters,
        },
    }
