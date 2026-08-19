"""The three model ports backed by one provider-neutral ModelGateway."""

from __future__ import annotations

import json
import math
from collections.abc import AsyncIterator, Sequence
from types import MappingProxyType
from typing import Any

from nova_audio_agent.context_view import ContextView
from nova_audio_agent.memory import MemoryItem
from nova_audio_agent.media import MediaStore, materialize_images, select_image_candidates
from nova_audio_agent.model_gateway import GatewayImage, GatewayTextDelta, ModelGateway
from nova_audio_agent.ports import (
    ActionDelta,
    ActionOutput,
    ContractFailureDelta,
    DelegateRequest,
    FastBrainDelta,
    SurrogateOutput,
    TextDelta,
    UpdateSpec,
)
from nova_audio_agent.prompting import (
    COMPRESSOR_SYSTEM,
    FASTBRAIN_SYSTEM,
    SURROGATE_SYSTEM,
    render_context_view,
    render_fastbrain_context,
)
from nova_audio_agent.tool_schema import CompiledTools, ToolBinding

_SURROGATE_SCHEMA = {
    "type": "object",
    "properties": {
        "speak": {"type": "boolean"},
        "suggestion_id": {"type": ["string", "null"]},
        "reason": {"type": "string"},
    },
    "required": ["speak", "suggestion_id", "reason"],
    "additionalProperties": False,
}


class GatewayFastBrain:
    def __init__(
        self,
        gateway: ModelGateway,
        *,
        model: str,
        tools: CompiledTools,
        media_store: MediaStore | None = None,
        system: str | None = None,
        include_trigger: bool = False,
    ) -> None:
        self._gateway = gateway
        self._model = model
        self._tools = tools
        self._media_store = media_store
        self._system = FASTBRAIN_SYSTEM if system is None else system
        self._include_trigger = include_trigger

    async def call(self, view: ContextView) -> AsyncIterator[FastBrainDelta]:
        calls: dict[int, list[str]] = {}
        active_tools = _tools_for_trigger(
            self._tools,
            trigger_kind=view.trigger_kind,
            enabled=self._include_trigger,
        )
        kwargs: dict[str, Any] = {
            "model": self._model,
            "system": self._system,
            "prompt": render_context_view(view, include_trigger=self._include_trigger),
            "tools": active_tools.schemas,
        }
        if self._media_store is not None:
            visual = materialize_images(
                view,
                select_image_candidates(view),
                self._media_store,
            )
            kwargs["prompt"] = render_fastbrain_context(
                view,
                visual.states,
                include_trigger=self._include_trigger,
            )
            kwargs["images"] = tuple(
                GatewayImage(image.ref, image.media_type, image.payload) for image in visual.images
            )
        async for delta in self._gateway.stream(**kwargs):
            if isinstance(delta, GatewayTextDelta):
                yield TextDelta(text=delta.text)
                continue
            slot = calls.setdefault(delta.index, ["", ""])
            slot[0] += delta.name
            slot[1] += delta.arguments

        for index in sorted(calls):
            name, raw_arguments = calls[index]
            yield _decode_tool_call(active_tools, name, raw_arguments)


def _tools_for_trigger(
    tools: CompiledTools,
    *,
    trigger_kind: str | None,
    enabled: bool,
) -> CompiledTools:
    if not enabled or trigger_kind == "user_input":
        return tools
    bindings = {
        name: binding for name, binding in tools.bindings.items() if binding.executor != "codex"
    }
    schemas = tuple(schema for schema in tools.schemas if schema["function"]["name"] in bindings)
    return CompiledTools(schemas=schemas, bindings=MappingProxyType(bindings))


def _decode_tool_call(
    tools: CompiledTools, name: str, raw_arguments: str
) -> ActionDelta | ContractFailureDelta:
    binding = tools.bindings.get(name)
    if binding is None:
        return ContractFailureDelta(code="unknown_tool", tool_name=name or None)
    try:
        arguments = json.loads(raw_arguments)
    except (json.JSONDecodeError, TypeError):
        return ContractFailureDelta(code="invalid_tool_arguments", tool_name=name)
    if (
        not isinstance(arguments, dict)
        or not all(isinstance(key, str) for key in arguments)
        or not _is_finite_binary64_json(arguments)
    ):
        return ContractFailureDelta(code="invalid_tool_arguments", tool_name=name)
    if binding.kind == "update":
        assert binding.target is not None
        return ActionDelta(
            action=ActionOutput(
                act="update",
                update=UpdateSpec(target=binding.target, delta=arguments),
            )
        )
    return _decode_delegate(binding, name, arguments)


def _is_finite_binary64_json(value: object) -> bool:
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return True
    if isinstance(value, int | float):
        try:
            return math.isfinite(float(value))
        except OverflowError:
            return False
    if isinstance(value, list):
        return all(_is_finite_binary64_json(item) for item in value)
    if isinstance(value, dict):
        return all(
            isinstance(key, str) and _is_finite_binary64_json(item) for key, item in value.items()
        )
    return False


def _decode_delegate(
    binding: ToolBinding, name: str, arguments: dict[str, Any]
) -> ActionDelta | ContractFailureDelta:
    origin_ref = arguments.pop("origin_ref", None)
    if not isinstance(origin_ref, str) or not origin_ref:
        return ContractFailureDelta(code="missing_origin_ref", tool_name=name)
    assert binding.executor is not None and binding.op is not None
    return ActionDelta(
        action=ActionOutput(
            act="delegate",
            delegate=DelegateRequest(
                executor=binding.executor,
                op=binding.op,
                request=arguments,
                origin_ref=origin_ref,
            ),
        )
    )


class GatewaySurrogate:
    def __init__(self, gateway: ModelGateway, *, model: str) -> None:
        self._gateway = gateway
        self._model = model

    async def watch(self, view: ContextView) -> SurrogateOutput:
        response = await self._gateway.complete(
            model=self._model,
            system=SURROGATE_SYSTEM,
            prompt=render_context_view(view),
            json_schema=_SURROGATE_SCHEMA,
        )
        try:
            value = json.loads(response.text)
        except json.JSONDecodeError as exc:
            raise ValueError("Surrogate 输出不是合法 JSON") from exc
        if (
            not isinstance(value, dict)
            or not isinstance(value.get("speak"), bool)
            or (
                value.get("suggestion_id") is not None
                and not isinstance(value.get("suggestion_id"), str)
            )
            or not isinstance(value.get("reason"), str)
        ):
            raise ValueError("Surrogate 输出不符合契约")
        return SurrogateOutput(
            speak=value["speak"],
            suggestion_id=value["suggestion_id"],
            reason=value["reason"],
        )


class GatewayCompressor:
    def __init__(self, gateway: ModelGateway, *, model: str) -> None:
        self._gateway = gateway
        self._model = model

    async def compress(self, items: Sequence[MemoryItem]) -> str:
        prompt = json.dumps(
            [
                {
                    "ref": item.ref,
                    "ts": item.ts,
                    "trust": item.trust,
                    "outcome": item.outcome,
                    "content": item.content,
                    "refs": item.refs,
                }
                for item in items
            ],
            ensure_ascii=False,
        )
        response = await self._gateway.complete(
            model=self._model,
            system=COMPRESSOR_SYSTEM,
            prompt=prompt,
        )
        return response.text.strip()
