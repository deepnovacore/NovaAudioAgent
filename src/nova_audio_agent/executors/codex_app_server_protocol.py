"""Bounded JSON-RPC and allowlisted app-server event projection."""

from __future__ import annotations

import asyncio
import json
import math
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol

from nova_audio_agent.clock import Clock
from nova_audio_agent.ports import PROGRESS_SUMMARY_LIMIT, ProgressPayload

MAX_JSONL_LINE = 256 * 1024
MAX_STDOUT = 2 * 1024 * 1024
MAX_REQUEST = 64 * 1024
MAX_FINAL_TEXT_INPUT = 65_536
MAX_INTERNAL_ACTIVITY = 1_048_576
WORKING_INTERVAL = 30.0
_SUMMARY_PROSE_LIMIT = 240


def _bounded(text: str, limit: int) -> str:
    """Construction-time string invariant: strip, collapse whitespace runs, clip by codepoint."""
    return " ".join(text.split())[:limit]


APP_SERVER_SCHEMAS: dict[str, tuple[str, dict[str, str], frozenset[str]]] = {
    "initialize": (
        "v1/InitializeParams.json",
        {"clientInfo": "object"},
        frozenset({"clientInfo"}),
    ),
    "config/read": (
        "v2/ConfigReadParams.json",
        {"includeLayers": "boolean", "cwd": "string"},
        frozenset(),
    ),
    "thread/start": (
        "v2/ThreadStartParams.json",
        {
            "ephemeral": "boolean",
            "approvalPolicy": "string",
            "developerInstructions": "string",
            "cwd": "string",
            "permissions": "string",
            "runtimeWorkspaceRoots": "array",
        },
        frozenset(),
    ),
    "thread/resume": (
        "v2/ThreadResumeParams.json",
        {
            "threadId": "string",
            "excludeTurns": "boolean",
            "approvalPolicy": "string",
            "developerInstructions": "string",
            "cwd": "string",
            "permissions": "string",
            "runtimeWorkspaceRoots": "array",
        },
        frozenset({"threadId"}),
    ),
    "turn/start": (
        "v2/TurnStartParams.json",
        {"threadId": "string", "input": "array"},
        frozenset({"threadId", "input"}),
    ),
    "turn/steer": (
        "v2/TurnSteerParams.json",
        {"threadId": "string", "expectedTurnId": "string", "input": "array"},
        frozenset({"threadId", "expectedTurnId", "input"}),
    ),
    "turn/interrupt": (
        "v2/TurnInterruptParams.json",
        {"threadId": "string", "turnId": "string"},
        frozenset({"threadId", "turnId"}),
    ),
}

APP_SERVER_INBOUND_SCHEMAS: tuple[tuple[str, dict[str, str], frozenset[str]], ...] = (
    (
        "v2/ConfigReadResponse.json",
        {"config": "object", "origins": "object"},
        frozenset({"config", "origins"}),
    ),
    (
        "v2/ThreadStartResponse.json",
        {
            "approvalPolicy": "string",
            "cwd": "string",
            "sandbox": "object",
            "thread": "object",
        },
        frozenset({"approvalPolicy", "cwd", "sandbox", "thread"}),
    ),
    (
        "v2/ThreadResumeResponse.json",
        {
            "approvalPolicy": "string",
            "cwd": "string",
            "runtimeWorkspaceRoots": "array",
            "sandbox": "object",
            "thread": "object",
        },
        frozenset({"approvalPolicy", "cwd", "sandbox", "thread"}),
    ),
    (
        "v2/TurnStartResponse.json",
        {"turn": "object"},
        frozenset({"turn"}),
    ),
    (
        "v2/TurnSteerResponse.json",
        {"turnId": "string"},
        frozenset({"turnId"}),
    ),
    (
        "v2/TurnStartedNotification.json",
        {"threadId": "string", "turn": "object"},
        frozenset({"threadId", "turn"}),
    ),
    (
        "v2/ItemCompletedNotification.json",
        {"threadId": "string", "turnId": "string", "item": "object"},
        frozenset({"threadId", "turnId", "item"}),
    ),
    (
        "v2/TurnCompletedNotification.json",
        {"threadId": "string", "turn": "object"},
        frozenset({"threadId", "turn"}),
    ),
)

APP_SERVER_NESTED_SCHEMAS: tuple[tuple[str, str, dict[str, str], frozenset[str]], ...] = (
    *(
        (
            relative,
            "thread",
            {"id": "string", "cwd": "string", "ephemeral": "boolean", "path": "string"},
            frozenset({"id", "cwd", "ephemeral"}),
        )
        for relative in ("v2/ThreadStartResponse.json", "v2/ThreadResumeResponse.json")
    ),
    *(
        (
            relative,
            "turn",
            {"id": "string", "items": "array", "status": "string"},
            frozenset({"id", "items", "status"}),
        )
        for relative in (
            "v2/TurnStartResponse.json",
            "v2/TurnStartedNotification.json",
            "v2/TurnCompletedNotification.json",
        )
    ),
)


class AppServerProtocolError(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class _Stdin(Protocol):
    def write(self, data: bytes) -> None: ...

    async def drain(self) -> None: ...


NotificationHandler = Callable[[tuple[str, dict[str, Any]]], None]
ServerRequestHandler = Callable[[str], None]


class JsonRpcConnection:
    """One JSONL reader, one short-held writer lock, and request futures."""

    def __init__(
        self,
        *,
        stdin: _Stdin,
        stdout: asyncio.StreamReader,
        on_notification: NotificationHandler,
        on_server_request: ServerRequestHandler | None = None,
    ) -> None:
        self._stdin = stdin
        self._stdout = stdout
        self._on_notification = on_notification
        self._on_server_request = on_server_request
        self._writer_lock = asyncio.Lock()
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._next_id = 0
        self._reader_task: asyncio.Task[None] | None = None
        self._failure: AppServerProtocolError | None = None
        self._stdout_bytes = 0

    def start(self) -> None:
        if self._reader_task is not None:
            raise RuntimeError("reader_already_started")
        self._reader_task = asyncio.create_task(self._read_loop())

    async def request(self, method: str, params: Mapping[str, Any]) -> Any:
        return await self.request_prepared(method, lambda: params)

    async def request_prepared(
        self,
        method: str,
        prepare: Callable[[], Mapping[str, Any]],
        *,
        on_written: Callable[[], None] | None = None,
    ) -> Any:
        """Build params under the writer lock so identity can be rechecked at write time."""
        loop = asyncio.get_running_loop()
        future: asyncio.Future[Any] = loop.create_future()
        async with self._writer_lock:
            self._raise_if_failed()
            params = prepare()
            self._next_id += 1
            request_id = self._next_id
            self._pending[request_id] = future
            try:
                await self._write({"method": method, "id": request_id, "params": dict(params)})
                if on_written is not None:
                    on_written()
            except asyncio.CancelledError:
                future.cancel()
                raise
            except Exception:
                self._pending.pop(request_id, None)
                raise
        return await future

    async def notify(self, method: str, params: Mapping[str, Any] | None = None) -> None:
        async with self._writer_lock:
            self._raise_if_failed()
            message: dict[str, Any] = {"method": method}
            if params is not None:
                message["params"] = dict(params)
            await self._write(message)

    async def respond_method_not_found(self, request_id: object) -> None:
        async with self._writer_lock:
            await self._write(
                {
                    "id": request_id,
                    "error": {"code": -32601, "message": "Method not implemented"},
                }
            )

    async def wait_closed(self) -> None:
        if self._reader_task is None:
            return
        await self._reader_task
        self._raise_if_failed()

    def _raise_if_failed(self) -> None:
        if self._failure is not None:
            raise self._failure

    async def _write(self, message: Mapping[str, Any]) -> None:
        try:
            data = (
                json.dumps(
                    message,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    allow_nan=False,
                ).encode("utf-8")
                + b"\n"
            )
        except (TypeError, ValueError, RecursionError):
            raise AppServerProtocolError("invalid_request") from None
        if len(data) > MAX_REQUEST:
            raise AppServerProtocolError("request_too_large")
        self._stdin.write(data)
        await self._stdin.drain()

    async def _read_loop(self) -> None:
        try:
            while True:
                line = await self._stdout.readline()
                if not line:
                    break
                if len(line) > MAX_JSONL_LINE:
                    raise AppServerProtocolError("stdout_line_too_large")
                self._stdout_bytes += len(line)
                if self._stdout_bytes > MAX_STDOUT:
                    raise AppServerProtocolError("stdout_too_large")
                message = _decode_message(line)
                if "method" in message and "id" in message:
                    method = message.get("method")
                    if type(method) is not str:
                        raise AppServerProtocolError("malformed_jsonl")
                    if self._on_server_request is not None:
                        self._on_server_request(method)
                    await self.respond_method_not_found(message["id"])
                    continue
                if "method" in message:
                    method = message.get("method")
                    params = message.get("params", {})
                    if type(method) is not str or type(params) is not dict:
                        raise AppServerProtocolError("malformed_jsonl")
                    self._on_notification((method, params))
                    continue
                if "id" in message:
                    self._route_response(message)
                    continue
                raise AppServerProtocolError("malformed_jsonl")
            self._pending = {
                request_id: future
                for request_id, future in self._pending.items()
                if not future.done()
            }
            if self._pending:
                raise AppServerProtocolError("transport_lost")
        except AppServerProtocolError as failure:
            self._failure = failure
        except ValueError:
            # asyncio.StreamReader enforces its own line limit before returning
            # the bytes, so normalize that implementation detail to our protocol code.
            self._failure = AppServerProtocolError("stdout_line_too_large")
        except Exception:
            self._failure = AppServerProtocolError("stream_failure")
        finally:
            failure = self._failure or AppServerProtocolError("transport_lost")
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(failure)
            self._pending.clear()

    def _route_response(self, message: dict[str, Any]) -> None:
        request_id = message.get("id")
        if type(request_id) is not int or isinstance(request_id, bool):
            raise AppServerProtocolError("malformed_jsonl")
        future = self._pending.pop(request_id, None)
        if future is None:
            raise AppServerProtocolError("unknown_response_id")
        if future.done():
            return
        if set(message) == {"id", "result"}:
            future.set_result(message["result"])
            return
        error = message.get("error")
        if set(message) == {"id", "error"} and type(error) is dict:
            code = error.get("code")
            safe_code = code if type(code) is int and not isinstance(code, bool) else -32000
            future.set_exception(AppServerRequestRejected(safe_code))
            return
        raise AppServerProtocolError("malformed_jsonl")


class AppServerRequestRejected(AppServerProtocolError):
    def __init__(self, server_code: int) -> None:
        self.server_code = server_code
        super().__init__("server_rejected")


def _decode_message(line: bytes) -> dict[str, Any]:
    try:
        value = json.loads(line.decode("utf-8"), parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise AppServerProtocolError("malformed_jsonl") from None
    if type(value) is not dict or not value:
        raise AppServerProtocolError("malformed_jsonl")
    return value


def _reject_constant(_value: str) -> None:
    raise ValueError("non-standard JSON constant")


def validate_schema_directory(root: Path) -> dict[str, bool]:
    """Require the exact typed request and inbound shapes consumed by live mode."""
    try:
        client_request = json.loads((root / "ClientRequest.json").read_text(encoding="utf-8"))
        variants = client_request.get("oneOf")
        if type(variants) is not list:
            raise ValueError
        request_variants: dict[str, dict[str, Any]] = {}
        for variant in variants:
            if type(variant) is not dict or type(variant.get("properties")) is not dict:
                continue
            method_schema = variant["properties"].get("method")
            if type(method_schema) is not dict or type(method_schema.get("enum")) is not list:
                continue
            enum = method_schema["enum"]
            if len(enum) == 1 and type(enum[0]) is str:
                request_variants[enum[0]] = variant
        result: dict[str, bool] = {}
        for method, (relative, fields, required) in APP_SERVER_SCHEMAS.items():
            variant = request_variants.get(method)
            if variant is None or not {"id", "method", "params"}.issubset(
                _required_fields(variant)
            ):
                raise ValueError
            params_schema = variant["properties"].get("params")
            if type(params_schema) is not dict or params_schema.get("$ref") != (
                f"#/definitions/{Path(relative).stem}"
            ):
                raise ValueError
            schema = json.loads((root / relative).read_text(encoding="utf-8"))
            _validate_object_schema(schema, fields=fields, required=required)
            result[method] = True
        for relative, fields, required in APP_SERVER_INBOUND_SCHEMAS:
            schema = json.loads((root / relative).read_text(encoding="utf-8"))
            _validate_object_schema(schema, fields=fields, required=required)
        for relative, field, fields, required in APP_SERVER_NESTED_SCHEMAS:
            schema = json.loads((root / relative).read_text(encoding="utf-8"))
            _validate_nested_object_schema(
                schema,
                field=field,
                fields=fields,
                required=required,
            )
        return result
    except (OSError, UnicodeError, ValueError, TypeError, RecursionError):
        raise AppServerProtocolError("unsupported_protocol") from None


def _validate_object_schema(
    schema: object,
    *,
    fields: Mapping[str, str],
    required: frozenset[str],
    root: Mapping[str, Any] | None = None,
) -> None:
    if type(schema) is not dict or schema.get("type") != "object":
        raise ValueError
    properties = schema.get("properties")
    if type(properties) is not dict or not required.issubset(_required_fields(schema)):
        raise ValueError
    type_root = schema if root is None else root
    for field, expected_type in fields.items():
        field_schema = properties.get(field)
        if type(field_schema) is not dict or expected_type not in _schema_types(
            field_schema, type_root
        ):
            raise ValueError


def _validate_nested_object_schema(
    schema: object,
    *,
    field: str,
    fields: Mapping[str, str],
    required: frozenset[str],
) -> None:
    if type(schema) is not dict or type(schema.get("properties")) is not dict:
        raise ValueError
    field_schema = schema["properties"].get(field)
    if type(field_schema) is not dict:
        raise ValueError
    target = _local_schema_target(field_schema, schema)
    _validate_object_schema(target, fields=fields, required=required, root=schema)


def _local_schema_target(node: Mapping[str, Any], root: Mapping[str, Any]) -> Mapping[str, Any]:
    reference = node.get("$ref")
    if type(reference) is str and reference.startswith("#/definitions/"):
        definitions = root.get("definitions")
        target = (
            None if type(definitions) is not dict else definitions.get(reference.rsplit("/", 1)[1])
        )
        if type(target) is dict:
            return target
    raise ValueError


def _required_fields(schema: Mapping[str, Any]) -> frozenset[str]:
    required = schema.get("required", [])
    if type(required) is not list or any(type(field) is not str for field in required):
        raise ValueError
    return frozenset(required)


def _schema_types(node: Mapping[str, Any], root: Mapping[str, Any]) -> frozenset[str]:
    found: set[str] = set()
    declared = node.get("type")
    if type(declared) is str:
        found.add(declared)
    elif type(declared) is list:
        found.update(item for item in declared if type(item) is str)
    reference = node.get("$ref")
    if type(reference) is str and reference.startswith("#/definitions/"):
        definitions = root.get("definitions")
        target = (
            None if type(definitions) is not dict else definitions.get(reference.rsplit("/", 1)[1])
        )
        if type(target) is dict:
            found.update(_schema_types(target, root))
    for keyword in ("anyOf", "oneOf", "allOf"):
        choices = node.get(keyword)
        if type(choices) is list:
            for choice in choices:
                if type(choice) is dict:
                    found.update(_schema_types(choice, root))
    return frozenset(found)


def validate_effective_config(
    response: object,
    *,
    workspace: Path,
    allow_replacement_instructions: bool = False,
) -> dict[str, str]:
    """Validate only security scalars and discard origins/layers immediately."""
    try:
        if type(response) is not dict or type(response.get("config")) is not dict:
            raise ValueError
        if response.get("warnings") or response.get("requirements"):
            raise ValueError
        config = response["config"]
        profile = config["permissions"]["nova_audio_agent"]
        if config.get("default_permissions") != "nova_audio_agent":
            raise ValueError
        if config.get("web_search") != "disabled":
            raise ValueError
        filesystem = profile.get("filesystem")
        if type(filesystem) is not dict:
            raise ValueError
        if filesystem.get(":root") != "read" or filesystem.get(":workspace_roots") != {
            ".": "write",
            ".git": "read",
            ".agents": "read",
            ".codex": "read",
        }:
            raise ValueError
        network = profile.get("network")
        if type(network) is not dict or network.get("enabled") is not False:
            raise ValueError
        shell = config.get("shell_environment_policy")
        if (
            type(shell) is not dict
            or shell.get("inherit") != "core"
            or shell.get("include_only") != ["PATH", "LANG", "LC_ALL", "TERM"]
        ):
            raise ValueError
        features = config.get("features")
        disabled = {
            "hooks",
            "apps",
            "multi_agent",
            "plugins",
            "remote_plugin",
            "plugin_sharing",
            "tool_suggest",
        }
        if type(features) is not dict or any(features.get(name) is not False for name in disabled):
            raise ValueError
        if config.get("mcp_servers") != {} or features.get("remote_control") is not False:
            raise ValueError
        replacement = config.get("model_instructions_file")
        if not allow_replacement_instructions and replacement is not None:
            raise ValueError
    except (KeyError, TypeError, ValueError, OSError):
        raise AppServerProtocolError("config_not_isolated") from None
    return {
        "default_permissions": "nova_audio_agent",
        "filesystem": "workspace_only",
        "network": "blocked",
        "web_search": "disabled",
        "shell_environment": "core_include_only",
        "extensions": "disabled",
        "mcp": "empty",
        "instructions": "replacement" if allow_replacement_instructions else "builtin",
    }


@dataclass(frozen=True, slots=True)
class TurnCompletion:
    status: Literal["completed", "failed"]
    final_text: str | None
    internal_activity: int


class AppServerTurnProjection:
    """Correlate private identities and project only bounded progress/final text."""

    def __init__(
        self,
        *,
        clock: Clock,
        on_progress: Callable[[ProgressPayload], None] | None,
    ) -> None:
        self._clock = clock
        self._on_progress = on_progress
        self._thread_id: str | None = None
        self._notification_turn_id: str | None = None
        self._response_turn_id: str | None = None
        self._active_turn_id: str | None = None
        self._started_at: float | None = None
        self._internal_activity = 0
        self._last_working_at: float | None = None
        self._has_emitted_prose = False
        self._completed_agent_text: str | None = None
        self._summary_prose: str | None = None
        self._commands = 0
        self._commands_failed = 0
        self._files_changed = 0
        self._tool_calls = 0

    @property
    def thread_id(self) -> str | None:
        return self._thread_id

    @property
    def active_pair(self) -> tuple[str, str] | None:
        if self._thread_id is None or self._active_turn_id is None:
            return None
        return self._thread_id, self._active_turn_id

    @property
    def turn_was_started(self) -> bool:
        return self._notification_turn_id is not None

    def bind_thread(
        self,
        response: object,
        *,
        workspace: Path,
        ephemeral: bool = True,
        expected_thread_id: str | None = None,
    ) -> None:
        try:
            if type(response) is not dict:
                raise ValueError
            thread = response["thread"]
            if type(thread) is not dict:
                raise ValueError
            thread_id = thread["id"]
            if type(thread_id) is not str or not thread_id:
                raise ValueError
            if expected_thread_id is not None and thread_id != expected_thread_id:
                raise ValueError
            if thread.get("ephemeral") is not ephemeral:
                raise ValueError
            thread_path = thread.get("path")
            if ephemeral and thread_path is not None:
                raise ValueError
            if not ephemeral and (type(thread_path) is not str or not thread_path):
                raise ValueError
            if Path(thread["cwd"]).resolve() != workspace.resolve():
                raise ValueError
            if Path(response["cwd"]).resolve() != workspace.resolve():
                raise ValueError
            if not ephemeral:
                roots = response.get("runtimeWorkspaceRoots")
                if type(roots) is not list or len(roots) != 1:
                    raise ValueError
                if type(roots[0]) is not str or Path(roots[0]).resolve() != workspace.resolve():
                    raise ValueError
            if response.get("approvalPolicy") != "never":
                raise ValueError
            active = response["activePermissionProfile"]
            if type(active) is not dict or active.get("id") != "nova_audio_agent":
                raise ValueError
        except (KeyError, TypeError, ValueError, OSError):
            raise AppServerProtocolError("unsupported_protocol") from None
        self._thread_id = thread_id

    def bind_turn_response(self, response: object) -> str:
        try:
            if type(response) is not dict or type(response.get("turn")) is not dict:
                raise ValueError
            turn_id = response["turn"]["id"]
            if type(turn_id) is not str or not turn_id:
                raise ValueError
        except (KeyError, TypeError, ValueError):
            raise AppServerProtocolError("unsupported_protocol") from None
        if self._notification_turn_id is not None and self._notification_turn_id != turn_id:
            raise AppServerProtocolError("turn_identity_mismatch")
        self._response_turn_id = turn_id
        return turn_id

    def notification(self, method: str, params: dict[str, Any]) -> TurnCompletion | None:
        if method == "turn/started":
            self._turn_started(params)
            return None
        if method == "item/completed":
            self._item_completed(params)
            return None
        if method == "turn/completed":
            return self._turn_completed(params)
        return None

    def _turn_started(self, params: dict[str, Any]) -> None:
        try:
            thread_id = params["threadId"]
            turn = params["turn"]
            turn_id = turn["id"]
        except (KeyError, TypeError):
            return
        if thread_id != self._thread_id or type(turn_id) is not str or not turn_id:
            return
        if self._notification_turn_id is not None:
            return
        if self._response_turn_id is not None and self._response_turn_id != turn_id:
            raise AppServerProtocolError("turn_identity_mismatch")
        self._notification_turn_id = turn_id
        self._active_turn_id = turn_id
        self._completed_agent_text = None
        self._summary_prose = None
        self._commands = 0
        self._commands_failed = 0
        self._files_changed = 0
        self._tool_calls = 0
        self._has_emitted_prose = False
        self._started_at = self._clock.now()
        self._last_working_at = self._started_at
        self._emit(ProgressPayload(phase="started", internal_activity=0, elapsed=0.0))

    def _item_completed(self, params: dict[str, Any]) -> None:
        if not self._matches_item(params) or self._started_at is None:
            return
        item = params["item"]
        if item.get("type") == "agentMessage" and type(item.get("text")) is str:
            self._completed_agent_text = item["text"][:MAX_FINAL_TEXT_INPUT]
        self._reduce_summary_item(item)
        if self._internal_activity >= MAX_INTERNAL_ACTIVITY:
            return
        self._internal_activity += 1
        now = self._clock.now()
        summary = self._compose_summary()
        if (
            self._last_working_at is not None and now - self._last_working_at >= WORKING_INTERVAL
        ) or (self._summary_prose is not None and not self._has_emitted_prose):
            self._last_working_at = now
            self._has_emitted_prose = self._has_emitted_prose or self._summary_prose is not None
            self._emit(
                ProgressPayload(
                    phase="working",
                    internal_activity=self._internal_activity,
                    elapsed=max(0.0, now - self._started_at),
                    summary=summary,
                )
            )

    def _reduce_summary_item(self, item: dict[str, Any]) -> None:
        """R103 closed source allowlist: latest agentMessage/plan prose plus typed
        category counts. Every other item type contributes no prose, and
        `reasoning`/`userMessage` never enter. Field tags are camelCase, pinned to
        the vendored 0.145.0 ThreadItem schema. R125 amends the cadence: the first
        count-only item no longer emits — the 30s window opens at turn start and
        only the first prose keeps its immediate one-shot."""
        item_type = item.get("type")
        if item_type in {"agentMessage", "plan"}:
            text = item.get("text")
            if type(text) is str:
                self._summary_prose = _bounded(text, _SUMMARY_PROSE_LIMIT)
        elif item_type == "commandExecution":
            self._commands += 1
            if item.get("exitCode") not in (0, None):
                self._commands_failed += 1
        elif item_type == "fileChange":
            changes = item.get("changes")
            self._files_changed += len(changes) if type(changes) is list else 1
        elif item_type in {"mcpToolCall", "webSearch"}:
            self._tool_calls += 1

    def _compose_summary(self) -> str | None:
        segments: list[str] = []
        if self._commands:
            failed = f"（{self._commands_failed} 条失败）" if self._commands_failed else ""
            segments.append(f"已执行 {self._commands} 条命令{failed}")
        if self._files_changed:
            segments.append(f"已修改 {self._files_changed} 处文件")
        if self._tool_calls:
            segments.append(f"已调用 {self._tool_calls} 次工具")
        digest = "、".join(segments)
        prose = self._summary_prose
        if digest and prose:
            combined = f"{digest}。{prose}"
        else:
            combined = digest or (prose or "")
        if not combined:
            return None
        return _bounded(combined, PROGRESS_SUMMARY_LIMIT)

    def _matches_item(self, params: dict[str, Any]) -> bool:
        return (
            self._thread_id is not None
            and self._active_turn_id is not None
            and params.get("threadId") == self._thread_id
            and params.get("turnId") == self._active_turn_id
            and type(params.get("item")) is dict
        )

    def _turn_completed(self, params: dict[str, Any]) -> TurnCompletion | None:
        try:
            thread_id = params["threadId"]
            turn = params["turn"]
            turn_id = turn["id"]
            status = turn["status"]
            items = turn["items"]
        except (KeyError, TypeError):
            return None
        if thread_id != self._thread_id or turn_id != self._active_turn_id:
            return None
        if status not in {"completed", "failed", "interrupted"} or type(items) is not list:
            raise AppServerProtocolError("unsupported_protocol")
        final_text: str | None = None
        for item in items:
            if type(item) is dict and item.get("type") == "agentMessage":
                text = item.get("text")
                if type(text) is str:
                    final_text = text
        if final_text is None and turn.get("itemsView") == "notLoaded":
            final_text = self._completed_agent_text
        self._active_turn_id = None
        self._completed_agent_text = None
        return TurnCompletion(
            status="completed" if status == "completed" else "failed",
            final_text=final_text,
            internal_activity=self._internal_activity,
        )

    def _emit(self, payload: ProgressPayload) -> None:
        if self._on_progress is None:
            return
        try:
            if (
                not math.isfinite(payload.elapsed)
                or payload.elapsed < 0
                or type(payload.internal_activity) is not int
            ):
                return
            self._on_progress(payload)
        except Exception:
            return
