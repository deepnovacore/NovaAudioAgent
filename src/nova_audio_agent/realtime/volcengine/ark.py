"""Volcengine Ark Responses API boundary helpers."""

from __future__ import annotations

from copy import deepcopy
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
import json
from typing import Any


def responses_tool_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Translate the repository's Chat Completions tool shape to Responses."""
    if schema.get("type") != "function" or type(schema.get("function")) is not dict:
        raise ValueError("tool schema must contain a function object")
    function = schema["function"]
    name = function.get("name")
    parameters = function.get("parameters")
    if type(name) is not str or not name or type(parameters) is not dict:
        raise ValueError("tool schema has an invalid function contract")
    translated: dict[str, Any] = {
        "type": "function",
        "name": name,
        "parameters": deepcopy(parameters),
    }
    description = function.get("description")
    if type(description) is str and description:
        translated["description"] = description
    return translated


class ArkResponsesError(RuntimeError):
    """A sanitized Ark failure that never contains provider content."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True, slots=True)
class ArkResponseStarted:
    response_id: str


@dataclass(frozen=True, slots=True)
class ArkTextDelta:
    text: str


@dataclass(frozen=True, slots=True)
class ArkToolCall:
    item_id: str
    call_id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True, slots=True)
class ArkResponseCompleted:
    response_id: str


@dataclass(frozen=True, slots=True)
class ArkResponseFailed:
    response_id: str
    code: str


ArkEvent = (
    ArkResponseStarted | ArkTextDelta | ArkToolCall | ArkResponseCompleted | ArkResponseFailed
)


class ArkResponsesClient:
    def __init__(self, *, client: Any, model: str, instructions: str) -> None:
        self._client = client
        self._model = model
        self._instructions = instructions

    async def close(self) -> None:
        await self._client.close()

    async def stream(
        self,
        *,
        input_items: Sequence[dict[str, Any]],
        tools: Sequence[dict[str, Any]],
        previous_response_id: str | None,
        workspace_context: str | None = None,
    ) -> AsyncIterator[ArkEvent]:
        kwargs: dict[str, Any] = {
            "model": self._model,
            "instructions": (
                self._instructions
                if workspace_context is None
                else f"{self._instructions}\n\n{workspace_context}"
            ),
            "input": list(input_items),
            "tools": list(tools),
            "parallel_tool_calls": False,
            "store": True,
            "stream": True,
            "extra_body": {"thinking": {"type": "disabled"}},
        }
        if previous_response_id is not None:
            kwargs["previous_response_id"] = previous_response_id
        try:
            stream = await self._client.responses.create(**kwargs)
            async for raw in stream:
                event = _normalize_event(raw)
                if event is not None:
                    yield event
        except ArkResponsesError:
            raise
        except Exception as exc:
            status_code = getattr(exc, "status_code", None)
            if type(status_code) is not int:
                status_code = None
            raise ArkResponsesError(
                f"Ark Responses 请求失败（{type(exc).__name__}）", status_code=status_code
            ) from exc


def _normalize_event(raw: Any) -> ArkEvent | None:
    event_type = getattr(raw, "type", "")
    if event_type == "response.created":
        return ArkResponseStarted(_response_id(raw))
    if event_type == "response.output_text.delta":
        delta = getattr(raw, "delta", None)
        if type(delta) is not str:
            raise ArkResponsesError("Ark 返回了无效文本增量")
        return ArkTextDelta(delta)
    if event_type == "response.output_item.done":
        item = getattr(raw, "item", None)
        if getattr(item, "type", None) != "function_call":
            return None
        raw_arguments = getattr(item, "arguments", None)
        try:
            arguments = json.loads(raw_arguments)
        except (TypeError, json.JSONDecodeError) as exc:
            raise ArkResponsesError("Ark 返回了无效工具参数") from exc
        values = (
            getattr(item, "id", None),
            getattr(item, "call_id", None),
            getattr(item, "name", None),
        )
        if not all(type(value) is str and value for value in values) or type(arguments) is not dict:
            raise ArkResponsesError("Ark 返回了无效工具调用")
        return ArkToolCall(values[0], values[1], values[2], arguments)
    if event_type == "response.completed":
        return ArkResponseCompleted(_response_id(raw))
    if event_type in {"response.failed", "response.incomplete"}:
        return ArkResponseFailed(_response_id(raw), event_type.removeprefix("response."))
    return None


def _response_id(raw: Any) -> str:
    response = getattr(raw, "response", None)
    response_id = getattr(response, "id", None)
    if type(response_id) is not str or not response_id:
        raise ArkResponsesError("Ark 响应缺少标识")
    return response_id
