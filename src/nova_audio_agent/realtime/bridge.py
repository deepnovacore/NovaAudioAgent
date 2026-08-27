"""Translate admitted realtime tool proposals into existing Runtime dispatch."""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, cast

from nova_audio_agent.events import UserInput, WakeReason
from nova_audio_agent.executors.codex_project_contract import normalize_project_request
from nova_audio_agent.memory import USER_PRIORITY, MemoryRef
from nova_audio_agent.ports import DelegateRequest, UpdateSpec
from nova_audio_agent.realtime.protocol import HostContextItem, HostResponseIntent, ToolCallReady
from nova_audio_agent.realtime.recall import (
    RecallOriginError,
    RecallScope,
    RecallView,
    compile_memory_recall,
    encode_memory_recall,
)
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.tool_schema import CompiledTools

_SYNCHRONOUS_PROJECT_ACTIONS = frozenset(
    {"list_workspaces", "create_workspace", "select_workspace", "list_sessions", "resume_session"}
)


def requires_synchronous_result(
    executor: str,
    op: str,
    arguments: Mapping[str, object],
    declared_sync_result: bool,
) -> bool:
    action = arguments.get("action")
    return declared_sync_result or (
        executor == "codex"
        and op == "project"
        and type(action) is str
        and action in _SYNCHRONOUS_PROJECT_ACTIONS
    )


@dataclass(frozen=True, slots=True)
class ToolAcceptance:
    accepted: bool
    code: str
    host_item: HostContextItem
    response_intent: HostResponseIntent
    delegate_id: str | None = None
    # R105: the accepted op declared sync_result, so the host item is a pending
    # tool result the service must resolve, not a delegation acknowledgement.
    sync_result: bool = False
    executor: str | None = None
    op: str | None = None
    inline_fulfilled: bool = False
    telemetry: Mapping[str, object] | None = None


class RealtimeRuntimeBridge:
    def __init__(
        self,
        *,
        runtime: Runtime,
        tools: CompiledTools,
        id_factory: Callable[[], str],
    ) -> None:
        self._runtime = runtime
        self._tools = tools
        self._id_factory = id_factory
        self._latest_user_origin_ref: MemoryRef | None = None
        self._query_digest_key = secrets.token_bytes(32)

    async def accept_user_transcript(self, text: str) -> MemoryRef:
        """Apply provider transcript evidence before it can authorize a tool proposal."""
        origin_ref = await self._runtime.ingest_user_input(UserInput(text=text))
        self._latest_user_origin_ref = origin_ref
        return origin_ref

    async def accept_tool_call(
        self,
        call: ToolCallReady,
        *,
        origin_ref: MemoryRef | None = None,
    ) -> ToolAcceptance:
        binding = self._tools.bindings.get(call.name)
        if binding is None:
            return self._refused(call, "unknown_tool")
        reason = WakeReason(
            kind="realtime_tool",
            priority=USER_PRIORITY,
            routing_class="user_awaited",
        )
        if binding.kind == "update":
            schema = self._wire_params(call.name)
            if (
                binding.target is None
                or schema is None
                or not _valid_params(call.arguments, schema)
            ):
                return self._refused(call, "invalid_params")
            accepted = self._runtime.update_external(
                UpdateSpec(target=binding.target, delta=dict(call.arguments)),
                reason=reason,
            )
            if not accepted:
                return self._refused(call, "invalid_params")
            host_item = self._tool_output(call, {"state": "completed"})
            return ToolAcceptance(
                accepted=True,
                code="completed",
                host_item=host_item,
                response_intent=HostResponseIntent.tool_result(host_item),
            )
        if binding.kind == "query":
            return self._accept_memory_recall(call, origin_ref=origin_ref)
        if binding.executor is None or binding.op is None:
            return self._refused(call, "unsupported_tool")
        arguments = dict(call.arguments)
        provider_origin_ref = arguments.pop("origin_ref", None)
        resolved_origin_ref = origin_ref or self._latest_user_origin_ref or provider_origin_ref
        if type(resolved_origin_ref) is not str or not resolved_origin_ref:
            return self._refused(call, "missing_origin_ref")
        adapter = self._runtime.executors.get(binding.executor)
        op = None if adapter is None else adapter.manifest.op(binding.op)
        if op is None:
            return self._refused(call, "invalid_params")
        if binding.executor == "codex" and binding.op == "project":
            normalized_project = normalize_project_request(arguments)
            if normalized_project is None:
                return self._refused(call, "invalid_params")
            arguments = normalized_project
        elif not _valid_params(arguments, op.params):
            return self._refused(call, "invalid_params")
        if binding.op == "start" and adapter.manifest.policy.suggest:
            # R128: a suggest-channel start window is an ambient observation —
            # its hit is the Surrogate's to arbitrate, not a user-awaited
            # result. stop/status (and every other executor) stay user_awaited.
            reason = WakeReason(
                kind="realtime_tool",
                priority=USER_PRIORITY,
                routing_class="ambient",
            )
        summary = str(
            arguments.get("work_order")
            or arguments.get("task")
            or arguments.get("condition")
            or call.name
        ).strip()[:240]
        if not summary:
            return self._refused(call, "invalid_params")
        sync_result = requires_synchronous_result(
            binding.executor,
            binding.op,
            arguments,
            op.sync_result,
        )
        if sync_result:
            # R105: hold the provider protocol open with a pending tool result;
            # the service resolves it from the correlated Handoff or Deadline.
            host_item = self._tool_output(call, {"state": "pending"})
            response_intent = HostResponseIntent.tool_result(host_item)
        else:
            host_item = self._tool_output(call, {"state": "accepted"})
            response_intent = HostResponseIntent.delegation_acknowledgement(
                item=host_item,
                task_summary=summary,
            )
        admission = self._runtime.dispatch_external(
            DelegateRequest(
                executor=binding.executor,
                op=binding.op,
                request=arguments,
                origin_ref=resolved_origin_ref,
            ),
            reason=reason,
        )
        if not admission.accepted or admission.delegate_id is None:
            return self._refused(call, "runtime_rejected")
        return ToolAcceptance(
            accepted=True,
            code="accepted",
            delegate_id=admission.delegate_id,
            host_item=host_item,
            response_intent=response_intent,
            sync_result=sync_result,
            executor=binding.executor,
            op=binding.op,
        )

    def _accept_memory_recall(
        self,
        call: ToolCallReady,
        *,
        origin_ref: MemoryRef | None,
    ) -> ToolAcceptance:
        schema = self._wire_params(call.name)
        if schema is None or not _valid_params(call.arguments, schema):
            return self._refused(call, "invalid_params")
        resolved_origin_ref = origin_ref or self._latest_user_origin_ref
        if type(resolved_origin_ref) is not str or not resolved_origin_ref:
            return self._refused(call, "missing_origin_ref")
        query = cast(str, call.arguments["query"])
        scope = cast(RecallScope, call.arguments["scope"])
        if not query.strip():
            return self._refused(call, "invalid_params")
        started_at = self._runtime.clock.now()
        digest = hmac.new(self._query_digest_key, query.encode(), hashlib.sha256).hexdigest()
        try:
            view = compile_memory_recall(
                self._runtime.memory,
                query=query,
                scope=scope,
                before_ref=resolved_origin_ref,
            )
        except RecallOriginError:
            return self._refused(call, "missing_origin_ref")
        except Exception as exc:
            print(
                f"[realtime-diagnostic] memory_recall_projection_error type={type(exc).__name__}",
                flush=True,
            )
            view = RecallView(
                state="error",
                scope=scope,
                raw_scanned=0,
                searched_count=0,
                scan_truncated=False,
                hits=(),
                omitted=0,
            )
            content = encode_memory_recall(view)
            telemetry = self._recall_telemetry(
                query_digest=digest,
                scope=scope,
                state="error",
                raw_scanned=0,
                searched_count=0,
                scan_truncated=False,
                hit_refs=(),
                matches={"lexical": 0, "recency_fallback": 0},
                omitted=0,
                started_at=started_at,
            )
            return self._inline_tool_result(call, content, code="error", telemetry=telemetry)

        content = encode_memory_recall(view)
        provider_view = json.loads(content)
        emitted_hits = provider_view["hits"]
        telemetry = self._recall_telemetry(
            query_digest=digest,
            scope=scope,
            state=provider_view["state"],
            raw_scanned=provider_view["raw_scanned"],
            searched_count=provider_view["searched_count"],
            scan_truncated=provider_view["scan_truncated"],
            hit_refs=tuple(hit["ref"] for hit in emitted_hits),
            matches={
                "lexical": sum(hit["match"] == "lexical" for hit in emitted_hits),
                "recency_fallback": sum(hit["match"] == "recency_fallback" for hit in emitted_hits),
            },
            omitted=provider_view["omitted"],
            started_at=started_at,
        )
        return self._inline_tool_result(call, content, code=view.state, telemetry=telemetry)

    def _inline_tool_result(
        self,
        call: ToolCallReady,
        content: str,
        *,
        code: str,
        telemetry: Mapping[str, object],
    ) -> ToolAcceptance:
        host_item = self._tool_output_content(call, content)
        return ToolAcceptance(
            accepted=True,
            code=code,
            host_item=host_item,
            response_intent=HostResponseIntent.tool_result(host_item),
            inline_fulfilled=True,
            telemetry=telemetry,
        )

    def _recall_telemetry(
        self,
        *,
        query_digest: str,
        scope: RecallScope,
        state: str,
        raw_scanned: int,
        searched_count: int,
        scan_truncated: bool,
        hit_refs: tuple[MemoryRef, ...],
        matches: dict[str, int],
        omitted: int,
        started_at: float,
    ) -> Mapping[str, object]:
        return MappingProxyType(
            {
                "query_digest": query_digest,
                "scope": scope,
                "state": state,
                "raw_scanned": raw_scanned,
                "searched_count": searched_count,
                "scan_truncated": scan_truncated,
                "hit_count": len(hit_refs),
                "hit_refs": hit_refs,
                "matches": matches,
                "omitted": omitted,
                "elapsed": max(0.0, self._runtime.clock.now() - started_at),
            }
        )

    def _refused(self, call: ToolCallReady, code: str) -> ToolAcceptance:
        host_item = self._tool_output(call, {"code": code, "state": "refused"})
        return ToolAcceptance(
            accepted=False,
            code=code,
            host_item=host_item,
            response_intent=HostResponseIntent.tool_result(host_item),
        )

    def _tool_output(self, call: ToolCallReady, value: dict[str, str]) -> HostContextItem:
        return self._tool_output_content(
            call,
            json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
        )

    def _tool_output_content(self, call: ToolCallReady, content: str) -> HostContextItem:
        return HostContextItem.tool_output(
            host_item_id=self._id_factory(),
            event_id=self._id_factory(),
            call_id=call.call_id,
            content=content,
        )

    def _wire_params(self, name: str) -> dict[str, Any] | None:
        for schema in self._tools.schemas:
            function = schema.get("function")
            if type(function) is dict and function.get("name") == name:
                params = function.get("parameters")
                return params if type(params) is dict else None
        return None


def _valid_params(arguments: dict[str, Any], schema: dict[str, Any]) -> bool:
    # Domain unions require an action-aware validator. Failing closed here prevents
    # a future oneOf schema from being silently treated as its permissive top level.
    if "oneOf" in schema:
        return False
    if schema.get("type") != "object":
        return False
    properties = schema.get("properties")
    if type(properties) is not dict:
        return False
    required = schema.get("required", ())
    if not isinstance(required, list | tuple) or not all(type(name) is str for name in required):
        return False
    if any(name not in arguments for name in required):
        return False
    if schema.get("additionalProperties") is False and any(
        name not in properties for name in arguments
    ):
        return False
    return all(_valid_value(value, properties[name]) for name, value in arguments.items())


def _valid_value(value: Any, schema: Any) -> bool:
    if type(schema) is not dict:
        return False
    kind = schema.get("type")
    if kind == "string":
        if type(value) is not str:
            return False
        enum = schema.get("enum")
        if enum is not None and (not isinstance(enum, list | tuple) or value not in enum):
            return False
        minimum = schema.get("minLength")
        maximum = schema.get("maxLength")
        return not (
            (type(minimum) is int and len(value) < minimum)
            or (type(maximum) is int and len(value) > maximum)
        )
    if kind == "integer":
        return type(value) is int
    if kind == "number":
        return type(value) in {int, float}
    if kind == "boolean":
        return type(value) is bool
    if kind == "array":
        return type(value) is list
    if kind == "object":
        return type(value) is dict
    return False
