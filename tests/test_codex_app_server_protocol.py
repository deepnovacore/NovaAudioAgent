from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.executors.codex_app_server_protocol import (
    AppServerProtocolError,
    AppServerTurnProjection,
    JsonRpcConnection,
    MAX_JSONL_LINE,
    MAX_STDOUT,
    validate_effective_config,
)
from nova_audio_agent.ports import ProgressPayload


class _Stdin:
    def __init__(self, *, fail_drain: bool = False) -> None:
        self.writes: list[dict[str, Any]] = []
        self.written = asyncio.Event()
        self.fail_drain = fail_drain

    def write(self, data: bytes) -> None:
        self.writes.append(json.loads(data))
        self.written.set()

    async def drain(self) -> None:
        if self.fail_drain:
            raise ConnectionError("closed before drain")


class _BlockingStdin(_Stdin):
    def __init__(self) -> None:
        super().__init__()
        self.drain_started = asyncio.Event()
        self.release_drain = asyncio.Event()
        self._block_next_drain = True

    async def drain(self) -> None:
        if not self._block_next_drain:
            return
        self._block_next_drain = False
        self.drain_started.set()
        await self.release_drain.wait()


def _reader() -> asyncio.StreamReader:
    return asyncio.StreamReader()


def _feed(reader: asyncio.StreamReader, message: dict[str, Any]) -> None:
    reader.feed_data(json.dumps(message, separators=(",", ":")).encode() + b"\n")


def _config(workspace: Path) -> dict[str, Any]:
    return {
        "config": {
            "approval_policy": "never",
            "web_search": "disabled",
            "default_permissions": "nova_audio_agent",
            "permissions": {
                "nova_audio_agent": {
                    "filesystem": {
                        ":root": "read",
                        ":workspace_roots": {
                            ".": "write",
                            ".git": "read",
                            ".agents": "read",
                            ".codex": "read",
                        },
                    },
                    "network": {"enabled": False},
                }
            },
            "shell_environment_policy": {
                "inherit": "core",
                "include_only": ["PATH", "LANG", "LC_ALL", "TERM"],
            },
            "features": {
                "hooks": False,
                "apps": False,
                "multi_agent": False,
                "plugins": False,
                "remote_plugin": False,
                "plugin_sharing": False,
                "tool_suggest": False,
                "remote_control": False,
            },
            "mcp_servers": {},
            "model_instructions_file": None,
            "cwd": str(workspace),
        },
        "origins": {"secret.path": {"ignored": True}},
        "layers": [{"config": {"credential": "must-not-be-retained"}}],
    }


def test_effective_config_accepts_only_the_fixed_live_profile(tmp_path: Path) -> None:
    assert validate_effective_config(_config(tmp_path), workspace=tmp_path) == {
        "default_permissions": "nova_audio_agent",
        "filesystem": "workspace_only",
        "network": "blocked",
        "web_search": "disabled",
        "shell_environment": "core_include_only",
        "extensions": "disabled",
        "mcp": "empty",
        "instructions": "builtin",
    }


@pytest.mark.parametrize(
    "path, value",
    [
        (("web_search",), "live"),
        (("default_permissions",), "danger"),
        (("permissions", "nova_audio_agent", "network", "enabled"), True),
        (("permissions", "nova_audio_agent", "filesystem", ":root"), "write"),
        (("shell_environment_policy", "inherit"), "all"),
        (("features", "plugins"), True),
        (("mcp_servers",), {"leak": {}}),
        (("features", "remote_control"), True),
        (("model_instructions_file",), "/tmp/replacement"),
    ],
)
def test_effective_config_rejects_each_capability_widening(
    tmp_path: Path, path: tuple[str, ...], value: object
) -> None:
    response = _config(tmp_path)
    target = response["config"]
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = value

    with pytest.raises(AppServerProtocolError, match="config_not_isolated"):
        validate_effective_config(response, workspace=tmp_path)


@pytest.mark.parametrize("field", ["warnings", "requirements"])
def test_effective_config_fails_closed_on_warning_or_requirement(
    tmp_path: Path,
    field: str,
) -> None:
    response = _config(tmp_path)
    response[field] = [{"source": "managed", "detail": "must not be retained"}]

    with pytest.raises(AppServerProtocolError, match="config_not_isolated"):
        validate_effective_config(response, workspace=tmp_path)


def test_thread_response_requires_the_named_active_permission_profile() -> None:
    projection = AppServerTurnProjection(clock=VirtualClock(), on_progress=None)

    with pytest.raises(AppServerProtocolError, match="unsupported_protocol"):
        projection.bind_thread(
            {
                "thread": {
                    "id": "thread",
                    "ephemeral": True,
                    "path": None,
                    "cwd": "/workspace",
                },
                "cwd": "/workspace",
                "approvalPolicy": "never",
                "sandbox": {"type": "workspaceWrite"},
            },
            workspace=Path("/workspace"),
        )


async def test_json_rpc_routes_responses_and_does_not_hold_writer_while_waiting() -> None:
    stdin = _Stdin()
    stdout = _reader()
    notifications: list[tuple[str, dict[str, Any]]] = []
    rpc = JsonRpcConnection(stdin=stdin, stdout=stdout, on_notification=notifications.append)
    rpc.start()

    first = asyncio.create_task(rpc.request("turn/start", {"threadId": "internal"}))
    await stdin.written.wait()
    stdin.written.clear()
    second = asyncio.create_task(rpc.request("turn/steer", {"expectedTurnId": "internal"}))
    await asyncio.wait_for(stdin.written.wait(), timeout=0.1)

    assert [message["id"] for message in stdin.writes] == [1, 2]
    _feed(stdout, {"method": "turn/started", "params": {"safe": True}})
    _feed(stdout, {"id": 2, "result": {"turnId": "turn-1"}})
    _feed(stdout, {"id": 1, "result": {"turn": {"id": "turn-1"}}})
    assert await first == {"turn": {"id": "turn-1"}}
    assert await second == {"turnId": "turn-1"}
    assert notifications == [("turn/started", {"safe": True})]

    stdout.feed_eof()
    await rpc.wait_closed()


async def test_request_is_marked_written_only_after_drain_succeeds() -> None:
    stdin = _Stdin(fail_drain=True)
    stdout = _reader()
    rpc = JsonRpcConnection(stdin=stdin, stdout=stdout, on_notification=lambda _item: None)
    rpc.start()
    marked: list[bool] = []

    with pytest.raises(ConnectionError):
        await rpc.request_prepared(
            "turn/start",
            lambda: {"threadId": "thread"},
            on_written=lambda: marked.append(True),
        )

    assert marked == []
    stdout.feed_eof()
    await rpc.wait_closed()


async def test_cancelled_response_wait_accepts_late_response_without_poisoning_reader() -> None:
    stdin = _Stdin()
    stdout = _reader()
    notification_seen = asyncio.Event()
    rpc = JsonRpcConnection(
        stdin=stdin,
        stdout=stdout,
        on_notification=lambda _item: notification_seen.set(),
    )
    rpc.start()

    cancelled = asyncio.create_task(rpc.request("turn/start", {"threadId": "thread"}))
    await stdin.written.wait()
    cancelled.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancelled

    _feed(stdout, {"id": 1, "result": {"turn": {"id": "late-turn"}}})
    _feed(stdout, {"method": "turn/started", "params": {"safe": True}})
    await asyncio.wait_for(notification_seen.wait(), timeout=0.1)

    stdin.written.clear()
    following = asyncio.create_task(rpc.request("config/read", {}))
    await asyncio.wait_for(stdin.written.wait(), timeout=0.1)
    _feed(stdout, {"id": 2, "result": {"config": {}}})
    assert await following == {"config": {}}

    stdout.feed_eof()
    await rpc.wait_closed()


async def test_cancelled_drain_does_not_turn_clean_eof_into_transport_loss() -> None:
    stdin = _BlockingStdin()
    stdout = _reader()
    rpc = JsonRpcConnection(stdin=stdin, stdout=stdout, on_notification=lambda _item: None)
    rpc.start()

    request = asyncio.create_task(rpc.request("turn/start", {"threadId": "thread"}))
    await stdin.drain_started.wait()
    request.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request

    stdout.feed_eof()
    await rpc.wait_closed()


async def test_json_rpc_refuses_server_request_without_waiting() -> None:
    stdin = _Stdin()
    stdout = _reader()
    requests: list[str] = []
    rpc = JsonRpcConnection(
        stdin=stdin,
        stdout=stdout,
        on_notification=lambda _item: None,
        on_server_request=requests.append,
    )
    rpc.start()

    _feed(stdout, {"id": 77, "method": "item/commandExecution/requestApproval", "params": {}})
    await asyncio.wait_for(stdin.written.wait(), timeout=0.1)

    assert stdin.writes == [
        {
            "id": 77,
            "error": {"code": -32601, "message": "Method not implemented"},
        }
    ]
    assert requests == ["item/commandExecution/requestApproval"]
    stdout.feed_eof()
    await rpc.wait_closed()


@pytest.mark.parametrize(
    "line, code",
    [
        (b"not-json\n", "malformed_jsonl"),
        (json.dumps({"id": 999, "result": {}}).encode() + b"\n", "unknown_response_id"),
        (b"{" + b"x" * MAX_JSONL_LINE + b"}\n", "stdout_line_too_large"),
    ],
)
async def test_json_rpc_fails_boundedly_on_bad_stream(line: bytes, code: str) -> None:
    stdin = _Stdin()
    stdout = _reader()
    rpc = JsonRpcConnection(stdin=stdin, stdout=stdout, on_notification=lambda _item: None)
    rpc.start()
    stdout.feed_data(line)
    stdout.feed_eof()

    with pytest.raises(AppServerProtocolError, match=code):
        await rpc.wait_closed()


async def test_json_rpc_bounds_total_stdout_across_valid_lines() -> None:
    stdin = _Stdin()
    stdout = _reader()
    rpc = JsonRpcConnection(stdin=stdin, stdout=stdout, on_notification=lambda _item: None)
    rpc.start()
    padding = "x" * 32_000
    line = json.dumps({"method": "unknown", "params": {"padding": padding}}).encode() + b"\n"
    for _ in range(MAX_STDOUT // len(line) + 2):
        stdout.feed_data(line)
    stdout.feed_eof()

    with pytest.raises(AppServerProtocolError, match="stdout_too_large"):
        await rpc.wait_closed()


def _summary_projection(
    clock: VirtualClock, progress: list[ProgressPayload]
) -> AppServerTurnProjection:
    projection = AppServerTurnProjection(clock=clock, on_progress=progress.append)
    projection.bind_thread(
        {
            "thread": {"id": "thread", "ephemeral": True, "path": None, "cwd": "/workspace"},
            "cwd": "/workspace",
            "approvalPolicy": "never",
            "activePermissionProfile": {"id": "nova_audio_agent"},
        },
        workspace=Path("/workspace"),
    )
    projection.notification("turn/started", {"threadId": "thread", "turn": {"id": "turn"}})
    return projection


def _complete_item(projection: AppServerTurnProjection, item: dict[str, Any]) -> None:
    projection.notification(
        "item/completed",
        {"threadId": "thread", "turnId": "turn", "item": item},
    )


def test_first_count_only_item_does_not_emit_a_working_event() -> None:
    """R125: the first count-only item stays silent; counts and the 30s window
    (opened at turn start) survive so the next keepalive still carries them."""
    clock = VirtualClock()
    progress: list[ProgressPayload] = []
    projection = _summary_projection(clock, progress)

    _complete_item(projection, {"type": "commandExecution", "command": "x", "exitCode": 0})

    assert progress == [ProgressPayload(phase="started", internal_activity=0, elapsed=0.0)]

    clock.advance_to(30.0)
    _complete_item(projection, {"type": "commandExecution", "command": "y", "exitCode": 0})

    assert progress[-1] == ProgressPayload(
        phase="working",
        internal_activity=2,
        elapsed=30.0,
        summary="已执行 2 条命令",
    )


def test_first_count_only_item_after_the_window_emits_as_a_keepalive() -> None:
    """R125: the 30s window opens at turn start, so a count-only first item that
    arrives late still emits immediately as the liveness keepalive."""
    clock = VirtualClock()
    progress: list[ProgressPayload] = []
    projection = _summary_projection(clock, progress)

    clock.advance_to(31.0)
    _complete_item(projection, {"type": "commandExecution", "command": "x", "exitCode": 0})

    assert progress[-1] == ProgressPayload(
        phase="working",
        internal_activity=1,
        elapsed=31.0,
        summary="已执行 1 条命令",
    )


def test_first_prose_item_emits_immediately_even_as_the_first_item() -> None:
    """R125 keeps the R103 one-shot: the first agentMessage/plan prose announces
    at once, inside the 30s window."""
    clock = VirtualClock()
    progress: list[ProgressPayload] = []
    projection = _summary_projection(clock, progress)

    _complete_item(projection, {"type": "agentMessage", "text": "正在搭建项目骨架"})

    assert progress == [
        ProgressPayload(phase="started", internal_activity=0, elapsed=0.0),
        ProgressPayload(
            phase="working",
            internal_activity=1,
            elapsed=0.0,
            summary="正在搭建项目骨架",
        ),
    ]


def test_working_summary_composes_latest_prose_and_typed_counts() -> None:
    """R103: prose from agentMessage/plan plus category counts, nothing operational."""
    clock = VirtualClock()
    progress: list[ProgressPayload] = []
    projection = _summary_projection(clock, progress)

    _complete_item(projection, {"type": "commandExecution", "command": "secret-cmd", "exitCode": 0})
    _complete_item(
        projection, {"type": "commandExecution", "command": "secret-fail", "exitCode": 1}
    )
    _complete_item(projection, {"type": "fileChange", "changes": [{"path": "a.py"}, {"path": "b"}]})
    _complete_item(projection, {"type": "mcpToolCall", "tool": "secret-tool"})
    _complete_item(projection, {"type": "plan", "text": "旧的计划"})
    _complete_item(projection, {"type": "agentMessage", "text": " 正在实现\n方块旋转 "})
    clock.advance_to(30.0)
    _complete_item(projection, {"type": "todoList", "text": "ignored-unknown-type"})

    assert [payload.phase for payload in progress] == [
        "started",
        "working",
        "working",
    ]
    assert [payload.summary for payload in progress] == [
        None,
        "已执行 2 条命令（1 条失败）、已修改 2 处文件、已调用 1 次工具。旧的计划",
        "已执行 2 条命令（1 条失败）、已修改 2 处文件、已调用 1 次工具。正在实现 方块旋转",
    ]
    serialized = repr(progress)
    assert "secret-cmd" not in serialized
    assert "secret-fail" not in serialized
    assert "secret-tool" not in serialized
    assert "ignored-unknown-type" not in serialized


def test_latest_prose_wins_between_agent_message_and_plan_items() -> None:
    clock = VirtualClock()
    progress: list[ProgressPayload] = []
    projection = _summary_projection(clock, progress)

    _complete_item(projection, {"type": "agentMessage", "text": "第一段说明"})
    _complete_item(projection, {"type": "plan", "text": "第二段计划"})
    clock.advance_to(30.0)
    _complete_item(projection, {"type": "commandExecution", "command": "x", "exitCode": 0})

    assert progress[1].summary == "第一段说明"
    assert progress[2].summary == "已执行 1 条命令。第二段计划"


def test_typed_activity_counts_never_copy_commands_paths_or_output() -> None:
    clock = VirtualClock()
    progress: list[ProgressPayload] = []
    projection = _summary_projection(clock, progress)

    _complete_item(
        projection,
        {
            "type": "commandExecution",
            "command": "SECRET-COMMAND",
            "aggregatedOutput": "SECRET-OUTPUT",
            "exitCode": 0,
        },
    )
    clock.advance_to(30.0)
    _complete_item(
        projection,
        {"type": "fileChange", "changes": [{"path": "/SECRET/PATH"}]},
    )

    assert [payload.summary for payload in progress] == [
        None,
        "已执行 1 条命令、已修改 1 处文件",
    ]
    assert "SECRET" not in repr(progress)


def test_first_worker_prose_is_not_lost_when_private_activity_opens_throttle() -> None:
    """Reasoning/counts may be first, but they must not hide actual worker narration."""
    clock = VirtualClock()
    progress: list[ProgressPayload] = []
    projection = _summary_projection(clock, progress)

    _complete_item(projection, {"type": "reasoning", "text": "SECRET-REASONING"})
    _complete_item(
        projection,
        {"type": "commandExecution", "command": "SECRET-COMMAND", "exitCode": 0},
    )
    _complete_item(projection, {"type": "agentMessage", "text": "正在实现俄罗斯方块引擎"})

    assert progress == [
        ProgressPayload(phase="started", internal_activity=0, elapsed=0.0),
        ProgressPayload(
            phase="working",
            internal_activity=3,
            elapsed=0.0,
            summary="已执行 1 条命令。正在实现俄罗斯方块引擎",
        ),
    ]
    assert "SECRET" not in repr(progress)


def test_reasoning_and_user_items_never_feed_the_summary() -> None:
    clock = VirtualClock()
    progress: list[ProgressPayload] = []
    projection = _summary_projection(clock, progress)

    _complete_item(projection, {"type": "reasoning", "text": "REASONING-SENTINEL"})
    clock.advance_to(30.0)
    _complete_item(projection, {"type": "userMessage", "text": "STEERING-SENTINEL"})

    assert [payload.phase for payload in progress] == ["started", "working"]
    assert [payload.summary for payload in progress] == [None, None]
    assert "SENTINEL" not in repr(progress)


def test_foreign_turn_items_contribute_nothing_to_the_summary() -> None:
    clock = VirtualClock()
    progress: list[ProgressPayload] = []
    projection = _summary_projection(clock, progress)

    projection.notification(
        "item/completed",
        {
            "threadId": "foreign",
            "turnId": "turn",
            "item": {"type": "agentMessage", "text": "FOREIGN-SENTINEL"},
        },
    )
    clock.advance_to(30.0)
    _complete_item(projection, {"type": "commandExecution", "command": "x", "exitCode": 0})

    assert progress[-1] == ProgressPayload(
        phase="working",
        internal_activity=1,
        elapsed=30.0,
        summary="已执行 1 条命令",
    )
    assert "FOREIGN-SENTINEL" not in repr(progress)


def test_summary_prose_is_bounded_and_whitespace_collapsed_at_construction() -> None:
    clock = VirtualClock()
    progress: list[ProgressPayload] = []
    projection = _summary_projection(clock, progress)

    _complete_item(projection, {"type": "agentMessage", "text": "  a\t\tb\n" + "长" * 300})

    assert progress[-1].summary == "a b " + "长" * 236
    assert len(progress[-1].summary or "") == 240


def test_items_inside_the_throttle_window_only_update_the_next_emission() -> None:
    """First worker prose bypasses the window once; typed updates remain throttled."""
    clock = VirtualClock()
    progress: list[ProgressPayload] = []
    projection = _summary_projection(clock, progress)

    _complete_item(projection, {"type": "commandExecution", "command": "x", "exitCode": 0})
    clock.advance_to(29.0)
    _complete_item(projection, {"type": "agentMessage", "text": "窗口内的最新说明"})

    assert progress[0].summary is None
    assert [payload.summary for payload in progress] == [
        None,
        "已执行 1 条命令。窗口内的最新说明",
    ]

    clock.advance_to(30.0)
    _complete_item(projection, {"type": "commandExecution", "command": "y", "exitCode": 0})
    assert progress[-1].summary == "已执行 1 条命令。窗口内的最新说明"

    clock.advance_to(59.0)
    _complete_item(projection, {"type": "commandExecution", "command": "z", "exitCode": 0})
    assert progress[-1].summary == "已执行 3 条命令。窗口内的最新说明"


def test_turn_projection_correlates_notification_before_response_and_throttles() -> None:
    clock = VirtualClock()
    progress: list[ProgressPayload] = []
    projection = AppServerTurnProjection(clock=clock, on_progress=progress.append)
    projection.bind_thread(
        {
            "thread": {
                "id": "thread-secret",
                "ephemeral": True,
                "path": None,
                "cwd": "/workspace",
            },
            "cwd": "/workspace",
            "approvalPolicy": "never",
            "activePermissionProfile": {"id": "nova_audio_agent"},
        },
        workspace=Path("/workspace"),
    )

    projection.notification(
        "turn/started",
        {"threadId": "thread-secret", "turn": {"id": "turn-secret", "items": []}},
    )
    projection.bind_turn_response({"turn": {"id": "turn-secret"}})
    projection.notification(
        "item/completed",
        {"threadId": "thread-secret", "turnId": "turn-secret", "item": {"secret": "drop"}},
    )
    clock.advance_to(29.0)
    projection.notification(
        "item/completed",
        {"threadId": "thread-secret", "turnId": "turn-secret", "item": {"secret": "drop"}},
    )
    clock.advance_to(30.0)
    projection.notification(
        "item/completed",
        {"threadId": "thread-secret", "turnId": "turn-secret", "item": {"secret": "drop"}},
    )

    assert progress == [
        ProgressPayload(phase="started", internal_activity=0, elapsed=0.0),
        ProgressPayload(phase="working", internal_activity=3, elapsed=30.0),
    ]

    completion = projection.notification(
        "turn/completed",
        {
            "threadId": "thread-secret",
            "turn": {
                "id": "turn-secret",
                "status": "completed",
                "items": [
                    {"type": "commandExecution", "command": "secret"},
                    {"type": "agentMessage", "text": "safe final"},
                ],
            },
        },
    )
    assert completion is not None
    assert completion.status == "completed"
    assert completion.final_text == "safe final"
    assert completion.internal_activity == 3
    assert projection.active_pair is None


def test_progress_callback_failure_does_not_break_terminal_projection() -> None:
    projection = AppServerTurnProjection(
        clock=VirtualClock(),
        on_progress=lambda _payload: (_ for _ in ()).throw(RuntimeError("decorator failed")),
    )
    projection.bind_thread(
        {
            "thread": {"id": "thread", "ephemeral": True, "path": None, "cwd": "/workspace"},
            "cwd": "/workspace",
            "approvalPolicy": "never",
            "activePermissionProfile": {"id": "nova_audio_agent"},
        },
        workspace=Path("/workspace"),
    )

    projection.notification("turn/started", {"threadId": "thread", "turn": {"id": "turn"}})
    projection.notification(
        "item/completed",
        {"threadId": "thread", "turnId": "turn", "item": {"type": "agentMessage", "text": "done"}},
    )
    completion = projection.notification(
        "turn/completed",
        {
            "threadId": "thread",
            "turn": {"id": "turn", "status": "completed", "items": [], "itemsView": "notLoaded"},
        },
    )

    assert completion is not None
    assert completion.final_text == "done"


def test_turn_projection_rejects_mismatched_turn_identity() -> None:
    projection = AppServerTurnProjection(clock=VirtualClock(), on_progress=None)
    projection.bind_thread(
        {
            "thread": {"id": "thread", "ephemeral": True, "path": None, "cwd": "/workspace"},
            "cwd": "/workspace",
            "approvalPolicy": "never",
            "activePermissionProfile": {"id": "nova_audio_agent"},
        },
        workspace=Path("/workspace"),
    )
    projection.notification(
        "turn/started",
        {"threadId": "thread", "turn": {"id": "notification-turn"}},
    )

    with pytest.raises(AppServerProtocolError, match="turn_identity_mismatch"):
        projection.bind_turn_response({"turn": {"id": "response-turn"}})


def _persistent_thread_response(workspace: Path, *, thread_id: str = "thread-a") -> dict[str, Any]:
    return {
        "thread": {
            "id": thread_id,
            "ephemeral": False,
            "path": "/private/persisted-rollout.jsonl",
            "cwd": str(workspace),
        },
        "cwd": str(workspace),
        "runtimeWorkspaceRoots": [str(workspace)],
        "approvalPolicy": "never",
        "activePermissionProfile": {"id": "nova_audio_agent"},
    }


def test_persistent_projection_accepts_only_the_expected_resumed_thread(tmp_path: Path) -> None:
    projection = AppServerTurnProjection(clock=VirtualClock(), on_progress=None)

    projection.bind_thread(
        _persistent_thread_response(tmp_path),
        workspace=tmp_path,
        ephemeral=False,
        expected_thread_id="thread-a",
    )

    assert projection.thread_id == "thread-a"


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value["thread"].__setitem__("id", "thread-b"),
        lambda value: value["thread"].__setitem__("cwd", "/other"),
        lambda value: value.__setitem__("cwd", "/other"),
        lambda value: value.__setitem__("runtimeWorkspaceRoots", ["/other"]),
        lambda value: value.__setitem__("runtimeWorkspaceRoots", [value["cwd"], "/other"]),
        lambda value: value.__setitem__("activePermissionProfile", {"id": "danger"}),
        lambda value: value["thread"].__setitem__("ephemeral", True),
    ],
)
def test_persistent_projection_rejects_identity_or_boundary_mismatch(
    tmp_path: Path,
    mutation: Any,
) -> None:
    response = _persistent_thread_response(tmp_path)
    mutation(response)
    projection = AppServerTurnProjection(clock=VirtualClock(), on_progress=None)

    with pytest.raises(AppServerProtocolError, match="unsupported_protocol"):
        projection.bind_thread(
            response,
            workspace=tmp_path,
            ephemeral=False,
            expected_thread_id="thread-a",
        )


def test_turn_projection_uses_only_matching_completed_agent_item_when_items_not_loaded() -> None:
    projection = AppServerTurnProjection(clock=VirtualClock(), on_progress=None)
    projection.bind_thread(
        {
            "thread": {"id": "thread", "ephemeral": True, "path": None, "cwd": "/workspace"},
            "cwd": "/workspace",
            "approvalPolicy": "never",
            "activePermissionProfile": {"id": "nova_audio_agent"},
        },
        workspace=Path("/workspace"),
    )
    projection.notification(
        "turn/started",
        {"threadId": "thread", "turn": {"id": "turn"}},
    )
    projection.notification(
        "item/completed",
        {
            "threadId": "foreign",
            "turnId": "turn",
            "item": {"type": "agentMessage", "text": "foreign secret"},
        },
    )
    projection.notification(
        "item/completed",
        {
            "threadId": "thread",
            "turnId": "turn",
            "item": {"type": "userMessage", "text": "steering secret"},
        },
    )
    projection.notification(
        "item/completed",
        {
            "threadId": "thread",
            "turnId": "turn",
            "item": {"type": "agentMessage", "text": "safe final"},
        },
    )

    completion = projection.notification(
        "turn/completed",
        {
            "threadId": "thread",
            "turn": {
                "id": "turn",
                "status": "completed",
                "items": [],
                "itemsView": "notLoaded",
            },
        },
    )

    assert completion is not None
    assert completion.final_text == "safe final"
