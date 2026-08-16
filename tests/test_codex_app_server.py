from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import time
from pathlib import Path
from typing import Any, Callable

import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.events import ProgressEvent
from nova_audio_agent.executors import codex_app_server
from nova_audio_agent.executors.codex import CODEX_POLICY, CodexProcessStatus
from nova_audio_agent.executors.codex_app_server import (
    LIVE_APP_SERVER_OPTIONS,
    STDERR_LIMIT,
    CodexAppServerTransport,
)
from nova_audio_agent.executors.codex_app_server_protocol import AppServerProtocolError
from nova_audio_agent.executors.codex_preflight import CODEX_ROOT_OVERRIDES, CodexPreflightReport
from nova_audio_agent.memory import Memory
from nova_audio_agent.ports import Delegate, ProgressPayload
from nova_audio_agent.runtime import Runtime


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
        "origins": {},
        "layers": [],
    }


class _Preflight:
    calls = 0

    async def run(self, *, timeout: float) -> CodexPreflightReport:
        self.calls += 1
        return CodexPreflightReport(
            version="0.145.0",
            root_matches=True,
            mount="workspace_only",
            subprocess="contained",
            network="blocked",
            credential_present=True,
            credential_identity="chatgpt",
            credential_policy="saved_login",
            limits={"cpu": "finite", "as": "finite", "nofile": "finite"},
        )


class _ProtocolProbe:
    def __init__(self, *, failure: bool = False) -> None:
        self.failure = failure
        self.calls = 0

    async def validate(self, **_kwargs: Any) -> None:
        self.calls += 1
        if self.failure:
            raise AppServerProtocolError("unsupported_protocol")


class _Stdin:
    def __init__(self, peer: "_Peer") -> None:
        self.peer = peer
        self.closed = False

    def write(self, data: bytes) -> None:
        self.peer.receive(json.loads(data))

    async def drain(self) -> None:
        await asyncio.sleep(0)

    def close(self) -> None:
        self.closed = True
        self.peer.close()

    async def wait_closed(self) -> None:
        return None


class _Process:
    def __init__(self, peer: "_Peer") -> None:
        self.stdin = _Stdin(peer)
        self.stdout = peer.stdout
        self.stderr = asyncio.StreamReader()
        self.stderr.feed_data(peer.stderr)
        self.returncode: int | None = None
        self.pid = 43210
        self._exited = asyncio.Event()
        self.terminate_calls = 0
        self.kill_calls = 0
        peer.on_close = self._clean_exit

    def _clean_exit(self) -> None:
        self.returncode = 0
        self.stderr.feed_eof()
        self._exited.set()

    async def wait(self) -> int:
        await self._exited.wait()
        assert self.returncode is not None
        return self.returncode

    def terminate(self) -> None:
        self.terminate_calls += 1
        self.returncode = -15
        self._exited.set()

    def kill(self) -> None:
        self.kill_calls += 1
        self.returncode = -9
        self._exited.set()


class _Peer:
    def __init__(
        self,
        workspace: Path,
        *,
        hold_completion: bool = False,
        server_exits_after_completion: bool = False,
        unexpected_before_turn: bool = False,
        unexpected_after_thread: bool = False,
        hold_interrupt_completion: bool = False,
        final_text: str = "done",
        complete_on_steer: bool = True,
        steer_error_code: int | None = None,
        drop_steer_response: bool = False,
        stderr: bytes = b"",
        multi_turn: bool = False,
        turn_statuses: tuple[str, ...] = (),
        final_texts: tuple[str, ...] = (),
        turn_items: tuple[dict[str, Any], ...] | None = None,
    ) -> None:
        self.workspace = workspace
        self.stdout = asyncio.StreamReader()
        self.messages: list[dict[str, Any]] = []
        self.multi_turn = multi_turn
        self.turn_statuses = turn_statuses
        self.final_texts = final_texts
        self.turn_count = 0
        self.hold_completion = hold_completion
        self.server_exits_after_completion = server_exits_after_completion
        self.unexpected_before_turn = unexpected_before_turn
        self.unexpected_after_thread = unexpected_after_thread
        self.hold_interrupt_completion = hold_interrupt_completion
        self.final_text = final_text
        self.complete_on_steer = complete_on_steer
        self.steer_error_code = steer_error_code
        self.drop_steer_response = drop_steer_response
        self.stderr = stderr
        self.turn_items = turn_items
        self.closed = False
        self.turn_started = asyncio.Event()
        self.interrupt_received = asyncio.Event()
        self.on_close: Callable[[], None] = lambda: None
        self._turn_request_id: int | None = None

    def receive(self, message: dict[str, Any]) -> None:
        self.messages.append(message)
        method = message.get("method")
        request_id = message.get("id")
        if method == "initialize":
            self._feed({"id": request_id, "result": {"userAgent": "codex"}})
        elif method == "initialized":
            self._feed({"method": "remoteControl/status/changed", "params": {"enabled": False}})
        elif method == "config/read":
            if self.unexpected_before_turn:
                self.unexpected_request()
            self._feed({"id": request_id, "result": _config(self.workspace)})
        elif method == "thread/start":
            self._feed(
                {
                    "id": request_id,
                    "result": {
                        "thread": {
                            "id": "thread-private",
                            "ephemeral": True,
                            "path": None,
                            "cwd": str(self.workspace),
                        },
                        "cwd": str(self.workspace),
                        "approvalPolicy": "never",
                        "activePermissionProfile": {"id": "nova_audio_agent"},
                    },
                }
            )
            if self.unexpected_after_thread:
                self.unexpected_request()
        elif method == "turn/start":
            self._turn_request_id = request_id
            self.turn_count += 1
            turn_id = self._turn_id()
            self._feed(
                {
                    "method": "turn/started",
                    "params": {
                        "threadId": "thread-private",
                        "turn": {"id": turn_id, "items": []},
                    },
                }
            )
            self._feed({"id": request_id, "result": {"turn": {"id": turn_id}}})
            items = (
                ({"type": "commandExecution", "command": "must-drop"},)
                if self.turn_items is None
                else self.turn_items
            )
            for item in items:
                self._feed(
                    {
                        "method": "item/completed",
                        "params": {
                            "threadId": "thread-private",
                            "turnId": turn_id,
                            "item": item,
                        },
                    }
                )
            self.turn_started.set()
            if not self.hold_completion:
                status = "completed"
                if self.turn_statuses and self.turn_count <= len(self.turn_statuses):
                    status = self.turn_statuses[self.turn_count - 1]
                self.complete(status=status)
                if self.server_exits_after_completion:
                    self.close()
        elif method == "turn/steer":
            if self.drop_steer_response:
                self.close()
            elif self.steer_error_code is not None:
                self._feed(
                    {
                        "id": request_id,
                        "error": {"code": self.steer_error_code, "message": "rejected"},
                    }
                )
            else:
                self._feed({"id": request_id, "result": {"turnId": "turn-private"}})
            if self.complete_on_steer and not self.drop_steer_response:
                self.complete()
        elif method == "turn/interrupt":
            self._feed({"id": request_id, "result": {}})
            self.interrupt_received.set()
            if not self.hold_interrupt_completion:
                self.complete(status="interrupted")

    def _turn_id(self) -> str:
        if not self.multi_turn:
            return "turn-private"
        return f"turn-{max(1, self.turn_count)}"

    def replay_stale_turn_started(self, turn_id: str) -> None:
        self._feed(
            {
                "method": "turn/started",
                "params": {
                    "threadId": "thread-private",
                    "turn": {"id": turn_id, "items": []},
                },
            }
        )

    def complete(self, *, status: str = "completed") -> None:
        text = self.final_text
        if self.final_texts and self.turn_count <= len(self.final_texts):
            text = self.final_texts[max(0, self.turn_count - 1)]
        self._feed(
            {
                "method": "turn/completed",
                "params": {
                    "threadId": "thread-private",
                    "turn": {
                        "id": self._turn_id(),
                        "status": status,
                        "items": [
                            {"type": "commandExecution", "command": "must-drop"},
                            {"type": "agentMessage", "text": text},
                        ],
                    },
                },
            }
        )

    def unexpected_request(self) -> None:
        self._feed({"id": 909, "method": "item/tool/requestUserInput", "params": {"secret": 1}})

    def _feed(self, message: dict[str, Any]) -> None:
        self.stdout.feed_data(json.dumps(message, separators=(",", ":")).encode() + b"\n")

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self.stdout.feed_eof()
        self.on_close()


class _Factory:
    def __init__(self, peer: _Peer) -> None:
        self.peer = peer
        self.process = _Process(peer)
        self.calls: list[tuple[tuple[str, ...], dict[str, Any]]] = []

    async def __call__(self, *argv: str, **kwargs: Any) -> _Process:
        self.calls.append((argv, kwargs))
        return self.process


def _transport(tmp_path: Path, peer: _Peer) -> tuple[CodexAppServerTransport, _Factory]:
    factory = _Factory(peer)
    return (
        CodexAppServerTransport(
            binary="codex-cli",
            workspace=tmp_path,
            preflight=_Preflight(),
            process_factory=factory,
            environ={"PATH": "/bin", "SECRET": "drop"},
            clock=VirtualClock(),
            protocol_probe=_ProtocolProbe(),
        ),
        factory,
    )


async def test_live_preflight_fails_when_the_configured_schema_is_unsupported(
    tmp_path: Path,
) -> None:
    peer = _Peer(tmp_path)
    transport, _factory = _transport(tmp_path, peer)
    transport._protocol_probe = _ProtocolProbe(failure=True)

    with pytest.raises(AppServerProtocolError, match="unsupported_protocol"):
        await transport.preflight()


async def test_run_uses_isolated_app_server_and_projects_bounded_evidence(tmp_path: Path) -> None:
    peer = _Peer(tmp_path)
    transport, factory = _transport(tmp_path, peer)
    statuses: list[CodexProcessStatus] = []
    progress: list[ProgressPayload] = []

    preflight = await transport.preflight()
    result = await transport.run(
        "private work order",
        on_status=statuses.append,
        on_progress=progress.append,
    )

    argv, kwargs = factory.calls[0]
    assert argv == ("codex-cli", *CODEX_ROOT_OVERRIDES, *LIVE_APP_SERVER_OPTIONS)
    assert kwargs["cwd"] == tmp_path
    assert kwargs["env"]["PATH"] == "/bin"
    assert kwargs["env"]["CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED"] == "1"
    assert Path(kwargs["env"]["CODEX_HOME"]).name.startswith("nova-audio-agent-codex-live-")
    assert "SECRET" not in kwargs["env"]
    assert preflight["version"] == "0.145.0"
    assert progress == [
        ProgressPayload(phase="started", internal_activity=0, elapsed=0.0),
    ]
    assert result.classification == "completed"
    assert result.code == "completed"
    assert result.content["events"] == [
        {"type": "thread.started"},
        {"type": "turn.started"},
        {"type": "internal_activity", "count": 1},
        {"type": "turn.completed"},
    ]
    assert result.content["result"]["final_message"]["text"] == "done"
    serialized = json.dumps(result.content)
    assert "thread-private" not in serialized
    assert "turn-private" not in serialized
    assert "must-drop" not in serialized
    thread_start = next(item for item in peer.messages if item.get("method") == "thread/start")
    developer_instructions = thread_start["params"]["developerInstructions"]
    assert "dependency ban" in developer_instructions
    assert "optional or fallback imports" in developer_instructions
    assert "Before the first tool call" in developer_instructions
    assert "user-facing progress message" in developer_instructions
    for forbidden_source in ("reasoning", "commands", "paths", "secrets"):
        assert forbidden_source in developer_instructions
    assert statuses == [
        CodexProcessStatus(running=True, exited=False),
        CodexProcessStatus(running=False, exited=True, terminal="completed", exit_code=0),
    ]


async def test_clean_stderr_eof_does_not_abort_an_active_turn(tmp_path: Path) -> None:
    peer = _Peer(tmp_path, hold_completion=True)
    transport, factory = _transport(tmp_path, peer)
    run = asyncio.create_task(
        transport.run("work", on_status=lambda _status: None, on_progress=lambda _item: None)
    )
    await peer.turn_started.wait()

    factory.process.stderr.feed_eof()
    for _ in range(10):
        await asyncio.sleep(0)

    assert run.done() is False
    peer.complete()
    result = await run
    assert (result.classification, result.code) == ("completed", "completed")


async def test_buffered_terminal_notification_wins_over_server_exit(tmp_path: Path) -> None:
    peer = _Peer(tmp_path, server_exits_after_completion=True)
    transport, _factory = _transport(tmp_path, peer)

    result = await transport.run(
        "work",
        on_status=lambda _status: None,
        on_progress=lambda _item: None,
    )

    assert result.classification == "completed"
    assert result.code == "completed"


async def test_same_turn_steer_is_written_while_turn_start_is_waiting(tmp_path: Path) -> None:
    peer = _Peer(tmp_path, hold_completion=True)
    transport, _factory = _transport(tmp_path, peer)
    run = asyncio.create_task(
        transport.run("work", on_status=lambda _status: None, on_progress=lambda _item: None)
    )
    await peer.turn_started.wait()

    steer = await transport.steer("new private constraint")
    result = await run

    assert steer.code == "accepted"
    assert steer.written is True
    steer_message = next(item for item in peer.messages if item.get("method") == "turn/steer")
    assert steer_message["params"] == {
        "threadId": "thread-private",
        "expectedTurnId": "turn-private",
        "input": [{"type": "text", "text": "new private constraint"}],
    }
    assert result.classification == "completed"

    stale = await transport.steer("do not send")
    assert (stale.code, stale.written) == ("stale_turn", False)
    assert sum(item.get("method") == "turn/steer" for item in peer.messages) == 1


async def test_final_handoff_redacts_work_order_and_steering_text(tmp_path: Path) -> None:
    work_order = "TOP-SECRET-WORK-ORDER-SENTINEL"
    instruction = "TOP-SECRET-STEERING-SENTINEL"
    peer = _Peer(
        tmp_path,
        hold_completion=True,
        final_text=f"echo {work_order} and {instruction}",
    )
    transport, _factory = _transport(tmp_path, peer)
    run = asyncio.create_task(
        transport.run(
            work_order,
            on_status=lambda _status: None,
            on_progress=lambda _item: None,
        )
    )
    await peer.turn_started.wait()

    steer = await transport.steer(instruction)
    result = await run

    assert steer.code == "accepted"
    serialized = json.dumps(result.content)
    assert work_order not in serialized
    assert instruction not in serialized
    assert serialized.count("[REDACTED]") == 2
    assert transport._sensitive_inputs == []


async def test_progress_summary_redacts_workspace_home_api_key_and_sensitive_inputs(
    tmp_path: Path,
) -> None:
    work_order = "TOP-SECRET-WORK-ORDER-SENTINEL"
    fake_api_key = "not-a-real-progress-token"
    secret_text = f"用 {fake_api_key} 在 {tmp_path} 和 /home/sentinel-user 里执行 {work_order}"
    peer = _Peer(tmp_path, turn_items=({"type": "agentMessage", "text": secret_text},))
    factory = _Factory(peer)
    transport = CodexAppServerTransport(
        binary="codex-cli",
        workspace=tmp_path,
        api_key=fake_api_key,
        preflight=_Preflight(),
        process_factory=factory,
        environ={"PATH": "/bin", "HOME": "/home/sentinel-user", "SECRET": "drop"},
        clock=VirtualClock(),
        protocol_probe=_ProtocolProbe(),
    )
    progress: list[ProgressPayload] = []

    result = await transport.run(
        work_order,
        on_status=lambda _status: None,
        on_progress=progress.append,
    )

    assert result.classification == "completed"
    working = [payload for payload in progress if payload.phase == "working"]
    assert working and working[0].summary is not None
    summary = working[0].summary
    assert fake_api_key not in summary
    assert str(tmp_path) not in summary
    assert "/home/sentinel-user" not in summary
    assert work_order not in summary
    assert "[REDACTED]" in summary


async def test_progress_summary_cap_reapplies_after_redaction(tmp_path: Path) -> None:
    """A 240-char prose that redaction expands past 400 chars must re-truncate."""
    peer = _Peer(tmp_path, turn_items=({"type": "agentMessage", "text": "zz" * 120},))
    factory = _Factory(peer)
    transport = CodexAppServerTransport(
        binary="codex-cli",
        workspace=tmp_path,
        api_key="zz",
        preflight=_Preflight(),
        process_factory=factory,
        environ={"PATH": "/bin", "SECRET": "drop"},
        clock=VirtualClock(),
        protocol_probe=_ProtocolProbe(),
    )
    progress: list[ProgressPayload] = []

    result = await transport.run(
        "task", on_status=lambda _status: None, on_progress=progress.append
    )

    assert result.classification == "completed"
    working = [payload for payload in progress if payload.phase == "working"]
    assert working and working[0].summary is not None
    assert len(working[0].summary) == 400


async def test_progress_sanitizer_failure_drops_summary_but_keeps_counters(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_sanitize = codex_app_server._sanitize_final_message

    def flaky(text: str, **kwargs: Any) -> dict[str, Any]:
        if "TRIGGER-SUMMARY" in text:
            raise RuntimeError("sanitizer failed")
        return real_sanitize(text, **kwargs)

    monkeypatch.setattr(codex_app_server, "_sanitize_final_message", flaky)
    peer = _Peer(tmp_path, turn_items=({"type": "agentMessage", "text": "TRIGGER-SUMMARY"},))
    transport, _factory = _transport(tmp_path, peer)
    progress: list[ProgressPayload] = []

    result = await transport.run(
        "work", on_status=lambda _status: None, on_progress=progress.append
    )

    assert result.classification == "completed"
    assert progress == [
        ProgressPayload(phase="started", internal_activity=0, elapsed=0.0),
        ProgressPayload(phase="working", internal_activity=1, elapsed=0.0, summary=None),
    ]
    assert "TRIGGER-SUMMARY" not in json.dumps(result.content)


async def test_progress_summary_sentinel_never_reaches_memory(tmp_path: Path) -> None:
    """R103 end-to-end guard: projection -> wrapper -> runtime apply -> Memory stays clean."""
    api_key = "not-a-real-e2e-token"
    peer = _Peer(tmp_path, turn_items=({"type": "agentMessage", "text": f"泄漏 {api_key} 结束"},))
    factory = _Factory(peer)
    transport = CodexAppServerTransport(
        binary="codex-cli",
        workspace=tmp_path,
        api_key=api_key,
        preflight=_Preflight(),
        process_factory=factory,
        environ={"PATH": "/bin", "SECRET": "drop"},
        clock=VirtualClock(),
        protocol_probe=_ProtocolProbe(),
    )
    progress: list[ProgressPayload] = []
    result = await transport.run(
        "task", on_status=lambda _status: None, on_progress=progress.append
    )
    assert result.classification == "completed"
    working = next(payload for payload in progress if payload.phase == "working")
    assert working.summary is not None

    runtime = Runtime(clock=VirtualClock(), memory=Memory(policies=(CODEX_POLICY,)))
    runtime.delegates.dispatch(
        Delegate(
            delegate_id="d-1",
            executor="codex",
            op="run",
            request={"prompt": "private"},
            origin_ref="conversation:1",
            deadline=60.0,
            routing_class="user_awaited",
            dispatched_at=0.0,
        )
    )
    runtime.apply(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase=working.phase,
            internal_activity=working.internal_activity,
            elapsed=working.elapsed,
            summary=working.summary,
            ts=1.0,
            seq=2,
        )
    )

    item = runtime.memory.channels["codex"].items[-1]
    assert item.content["summary"] == working.summary
    assert api_key not in json.dumps(item.content, ensure_ascii=False)
    assert "[REDACTED]" in working.summary


async def test_distinct_steers_are_serialized_in_writer_order(tmp_path: Path) -> None:
    peer = _Peer(tmp_path, hold_completion=True, complete_on_steer=False)
    transport, _factory = _transport(tmp_path, peer)
    run = asyncio.create_task(
        transport.run("work", on_status=lambda _status: None, on_progress=lambda _item: None)
    )
    await peer.turn_started.wait()

    first = asyncio.create_task(transport.steer("first"))
    second = asyncio.create_task(transport.steer("second"))
    first_result, second_result = await asyncio.gather(first, second)
    peer.complete()
    await run

    assert (first_result.code, second_result.code) == ("accepted", "accepted")
    messages = [item for item in peer.messages if item.get("method") == "turn/steer"]
    assert [item["params"]["input"][0]["text"] for item in messages] == ["first", "second"]


@pytest.mark.parametrize(
    "server_code, expected",
    [(-32602, "stale_turn"), (-32000, "server_rejected")],
)
async def test_explicit_steer_rejection_is_classified(
    tmp_path: Path, server_code: int, expected: str
) -> None:
    peer = _Peer(
        tmp_path,
        hold_completion=True,
        complete_on_steer=False,
        steer_error_code=server_code,
    )
    transport, _factory = _transport(tmp_path, peer)
    run = asyncio.create_task(
        transport.run("work", on_status=lambda _status: None, on_progress=lambda _item: None)
    )
    await peer.turn_started.wait()

    steer = await transport.steer("constraint")
    peer.complete()
    await run

    assert (steer.code, steer.written) == (expected, True)


async def test_written_steer_with_lost_response_is_unknown(tmp_path: Path) -> None:
    peer = _Peer(
        tmp_path,
        hold_completion=True,
        complete_on_steer=False,
        drop_steer_response=True,
    )
    transport, _factory = _transport(tmp_path, peer)
    run = asyncio.create_task(
        transport.run("work", on_status=lambda _status: None, on_progress=lambda _item: None)
    )
    await peer.turn_started.wait()

    steer = await transport.steer("constraint")
    result = await run

    assert (steer.code, steer.written) == ("transport_lost", True)
    assert result.classification == "uncertain"


async def test_oversized_stderr_fails_boundedly_after_turn_write(tmp_path: Path) -> None:
    peer = _Peer(tmp_path, stderr=b"x" * (STDERR_LIMIT + 1))
    transport, _factory = _transport(tmp_path, peer)

    result = await transport.run(
        "work",
        on_status=lambda _status: None,
        on_progress=lambda _item: None,
    )

    assert result.classification == "uncertain"
    assert result.code == "stderr_too_large"


async def test_unexpected_server_request_is_refused_and_taints_started_run(tmp_path: Path) -> None:
    peer = _Peer(tmp_path, hold_completion=True)
    transport, _factory = _transport(tmp_path, peer)
    run = asyncio.create_task(
        transport.run("work", on_status=lambda _status: None, on_progress=lambda _item: None)
    )
    await peer.turn_started.wait()
    peer.unexpected_request()
    peer.complete()

    result = await run

    assert result.classification == "uncertain"
    assert result.code == "unexpected_server_request"
    refusal = next(item for item in peer.messages if item.get("id") == 909)
    assert refusal == {
        "id": 909,
        "error": {"code": -32601, "message": "Method not implemented"},
    }


async def test_server_request_before_turn_is_refused_as_unsupported_protocol(
    tmp_path: Path,
) -> None:
    peer = _Peer(tmp_path, unexpected_before_turn=True)
    transport, _factory = _transport(tmp_path, peer)

    result = await transport.run(
        "work",
        on_status=lambda _status: None,
        on_progress=lambda _item: None,
    )

    assert result.classification == "refused"
    assert result.code == "unsupported_protocol"
    assert not any(item.get("method") == "turn/start" for item in peer.messages)
    refusal = next(item for item in peer.messages if item.get("id") == 909)
    assert refusal["error"]["code"] == -32601


async def test_server_request_after_thread_response_cannot_race_turn_write(tmp_path: Path) -> None:
    peer = _Peer(tmp_path, unexpected_after_thread=True)
    transport, _factory = _transport(tmp_path, peer)

    result = await transport.run(
        "work",
        on_status=lambda _status: None,
        on_progress=lambda _item: None,
    )

    assert result.classification == "refused"
    assert result.code == "unsupported_protocol"
    assert not any(item.get("method") == "turn/start" for item in peer.messages)


async def test_cancellation_waits_for_terminal_notification_after_interrupt(tmp_path: Path) -> None:
    peer = _Peer(tmp_path, hold_completion=True, hold_interrupt_completion=True)
    transport, factory = _transport(tmp_path, peer)
    run = asyncio.create_task(
        transport.run("work", on_status=lambda _status: None, on_progress=lambda _item: None)
    )
    await peer.turn_started.wait()

    run.cancel()
    await peer.interrupt_received.wait()
    await asyncio.sleep(0)

    assert factory.process.stdin.closed is False
    assert factory.process.terminate_calls == 0
    assert factory.process.kill_calls == 0

    peer.complete(status="interrupted")
    with pytest.raises(asyncio.CancelledError):
        await run


async def test_repeated_cancellation_cannot_orphan_the_app_server(tmp_path: Path) -> None:
    peer = _Peer(tmp_path, hold_completion=True, hold_interrupt_completion=True)
    transport, factory = _transport(tmp_path, peer)
    run = asyncio.create_task(
        transport.run("work", on_status=lambda _status: None, on_progress=lambda _item: None)
    )
    await peer.turn_started.wait()

    run.cancel()
    await peer.interrupt_received.wait()
    run.cancel()

    with pytest.raises(asyncio.CancelledError):
        await run
    assert factory.process.returncode is not None
    assert factory.process.kill_calls == 1
    assert transport._process is None
    assert transport._projection is None


@pytest.mark.real_time
async def test_process_tree_wait_uses_bounded_polling(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = _Process(_Peer(tmp_path))
    process.returncode = 0
    stop_at = time.monotonic() + 0.03
    checks = 0

    def process_tree_running(_process: _Process) -> bool:
        nonlocal checks
        checks += 1
        return time.monotonic() < stop_at

    monkeypatch.setattr(codex_app_server, "_process_tree_running", process_tree_running)

    await codex_app_server._wait_process_tree(process)

    assert checks <= 10


@pytest.mark.real_time
async def test_stop_process_reaps_descendant_after_leader_exits(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    child_pid_path = tmp_path / "child.pid"
    child = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"
    parent = (
        "import pathlib,subprocess,sys; "
        "child=subprocess.Popen([sys.executable,'-c',sys.argv[2]]); "
        "pathlib.Path(sys.argv[1]).write_text(str(child.pid)); "
        "sys.stdin.buffer.read()"
    )
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        parent,
        str(child_pid_path),
        child,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        start_new_session=True,
    )
    peer = _Peer(tmp_path)
    transport, _factory = _transport(tmp_path, peer)
    transport._process = process
    monkeypatch.setattr(codex_app_server, "EXIT_GRACE", 0.05)
    child_pid: int | None = None
    try:
        for _ in range(100):
            if child_pid_path.exists():
                child_pid = int(child_pid_path.read_text())
                break
            await asyncio.sleep(0.01)
        assert child_pid is not None

        stop = await transport._stop_process()

        assert stop == "kill"
        with pytest.raises(ProcessLookupError):
            os.kill(child_pid, 0)
    finally:
        if child_pid is not None:
            try:
                os.kill(child_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if process.returncode is None:
            process.kill()
        await process.wait()


async def test_protocol_failure_reports_process_as_stopped(tmp_path: Path) -> None:
    peer = _Peer(tmp_path, hold_completion=True)
    transport, _factory = _transport(tmp_path, peer)
    statuses: list[CodexProcessStatus] = []
    run = asyncio.create_task(
        transport.run("work", on_status=statuses.append, on_progress=lambda _item: None)
    )
    await peer.turn_started.wait()

    peer.stdout.feed_data(b"not-json\n")
    result = await run

    assert result.classification == "uncertain"
    assert statuses[-1].running is False
    assert statuses[-1].exited is True
    assert statuses[-1].terminal == "failed"


async def test_steer_without_a_process_does_not_write(tmp_path: Path) -> None:
    peer = _Peer(tmp_path)
    transport, factory = _transport(tmp_path, peer)

    result = await transport.steer("unused")

    assert (result.code, result.written) == ("no_active_turn", False)
    assert factory.calls == []


class _RespawningFactory:
    def __init__(self, make_peer: Callable[[], _Peer]) -> None:
        self.make_peer = make_peer
        self.peers: list[_Peer] = []
        self.processes: list[_Process] = []

    async def __call__(self, *argv: str, **kwargs: Any) -> _Process:
        peer = self.make_peer()
        self.peers.append(peer)
        process = _Process(peer)
        self.processes.append(process)
        return process


def _warm_transport(
    tmp_path: Path, make_peer: Callable[[], _Peer]
) -> tuple[CodexAppServerTransport, _RespawningFactory]:
    factory = _RespawningFactory(make_peer)
    return (
        CodexAppServerTransport(
            binary="codex-cli",
            workspace=tmp_path,
            preflight=_Preflight(),
            process_factory=factory,
            environ={"PATH": "/bin", "SECRET": "drop"},
            clock=VirtualClock(),
            protocol_probe=_ProtocolProbe(),
        ),
        factory,
    )


def _method_count(peer: _Peer, method: str) -> int:
    return sum(1 for message in peer.messages if message.get("method") == method)


async def test_prewarm_establishes_the_thread_before_the_first_run(tmp_path: Path) -> None:
    """The startup handshake (spawn, init, config, thread) leaves the first turn's path."""
    transport, factory = _warm_transport(tmp_path, lambda: _Peer(tmp_path, multi_turn=True))

    await transport.prewarm()

    assert len(factory.processes) == 1
    peer = factory.peers[0]
    assert _method_count(peer, "initialize") == 1
    assert _method_count(peer, "thread/start") == 1
    assert _method_count(peer, "turn/start") == 0
    assert factory.processes[0].returncode is None

    result = await transport.run("task-1", on_status=lambda _status: None, on_progress=None)

    assert result.classification == "completed"
    assert len(factory.processes) == 1
    assert _method_count(peer, "initialize") == 1
    assert _method_count(peer, "thread/start") == 1
    assert _method_count(peer, "turn/start") == 1
    assert transport._preflight.calls == 1  # type: ignore[attr-defined]


async def test_completed_turns_reuse_the_warm_process_and_thread(tmp_path: Path) -> None:
    transport, factory = _warm_transport(
        tmp_path, lambda: _Peer(tmp_path, multi_turn=True, final_texts=("答复一", "答复二"))
    )
    await transport.prewarm()

    first = await transport.run("task-1", on_status=lambda _s: None, on_progress=None)
    second = await transport.run("task-2", on_status=lambda _s: None, on_progress=None)

    assert first.classification == "completed"
    assert second.classification == "completed"
    assert second.content["result"]["final_message"]["text"] == "答复二"
    assert len(factory.processes) == 1
    peer = factory.peers[0]
    assert _method_count(peer, "thread/start") == 1
    assert _method_count(peer, "turn/start") == 2
    assert factory.processes[0].returncode is None
    assert second.content["protocol"]["transport_closed"] is False
    assert second.content["process"]["exit_code"] is None
    assert second.content["process"]["stop"] == "none"


async def test_closed_warm_rpc_with_live_process_recovers_before_turn_write(tmp_path: Path) -> None:
    """Stdout EOF is process decay even when the child return code has not arrived yet."""
    transport, factory = _warm_transport(
        tmp_path,
        lambda: _Peer(tmp_path, multi_turn=True),
    )
    await transport.prewarm()
    dead_peer = factory.peers[0]
    dead_process = factory.processes[0]
    dead_peer.stdout.feed_eof()
    for _ in range(10):
        await asyncio.sleep(0)

    assert transport._rpc_wait is not None  # type: ignore[attr-defined]
    assert transport._rpc_wait.done()  # type: ignore[attr-defined]
    assert dead_process.returncode is None

    result = await transport.run("task-1", on_status=lambda _s: None, on_progress=None)

    assert result.classification == "completed"
    assert _method_count(dead_peer, "turn/start") == 0
    assert len(factory.processes) == 2
    assert _method_count(factory.peers[1], "turn/start") == 1


async def test_non_completed_turn_recycles_the_process(tmp_path: Path) -> None:
    """Reuse is earned by a clean turn; anything else tears the session down."""
    transport, factory = _warm_transport(
        tmp_path,
        lambda: _Peer(
            tmp_path,
            multi_turn=True,
            server_exits_after_completion=len(factory_holder) > 0,
            turn_statuses=("failed",) if not factory_holder else (),
        ),
    )
    factory_holder: list[int] = []

    failed = await transport.run("task-1", on_status=lambda _s: None, on_progress=None)

    assert failed.classification == "uncertain"
    assert failed.code == "turn_failed"
    assert len(factory.processes) == 1
    assert factory.processes[0].returncode is not None

    factory_holder.append(1)
    recovered = await transport.run("task-2", on_status=lambda _s: None, on_progress=None)

    assert recovered.classification == "completed"
    assert len(factory.processes) == 2


async def test_stale_turn_started_cannot_hijack_the_next_warm_turn(tmp_path: Path) -> None:
    """A replayed turn/started from a finished turn must be dropped by the lease."""
    transport, factory = _warm_transport(tmp_path, lambda: _Peer(tmp_path, multi_turn=True))
    await transport.prewarm()
    first = await transport.run("task-1", on_status=lambda _s: None, on_progress=None)
    assert first.classification == "completed"

    factory.peers[0].replay_stale_turn_started("turn-1")
    second = await transport.run("task-2", on_status=lambda _s: None, on_progress=None)

    assert second.classification == "completed"
    assert len(factory.processes) == 1


async def test_aclose_reaps_the_warm_process_and_private_home(tmp_path: Path) -> None:
    homes: list[Path] = []
    factory = _RespawningFactory(lambda: _Peer(tmp_path, multi_turn=True))
    transport = CodexAppServerTransport(
        binary="codex-cli",
        workspace=tmp_path,
        preflight=_Preflight(),
        process_factory=factory,
        environ={"PATH": "/bin", "SECRET": "drop"},
        clock=VirtualClock(),
        home_observer=homes.append,
        protocol_probe=_ProtocolProbe(),
    )
    await transport.prewarm()
    assert factory.processes[0].returncode is None

    await transport.aclose()

    assert factory.processes[0].returncode is not None
    assert homes and not homes[0].exists()

    reopened = await transport.run("task-1", on_status=lambda _s: None, on_progress=None)
    assert reopened.classification == "completed"
    assert len(factory.processes) == 2


async def test_sensitive_inputs_redact_across_warm_turns(tmp_path: Path) -> None:
    """An earlier work order surfacing in a later final message must still be redacted."""
    transport, factory = _warm_transport(
        tmp_path,
        lambda: _Peer(
            tmp_path,
            multi_turn=True,
            final_texts=("好的", "上一单是：机密工单甲"),
        ),
    )
    await transport.prewarm()
    await transport.run("机密工单甲", on_status=lambda _s: None, on_progress=None)

    second = await transport.run("任务乙", on_status=lambda _s: None, on_progress=None)

    text = second.content["result"]["final_message"]["text"]
    assert "机密工单甲" not in text
    assert "[REDACTED]" in text


async def test_warm_thread_recycles_at_the_turn_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Bound thread-context growth: reuse stops after MAX_TURNS_PER_THREAD clean turns."""
    monkeypatch.setattr(codex_app_server, "MAX_TURNS_PER_THREAD", 1)
    transport, factory = _warm_transport(tmp_path, lambda: _Peer(tmp_path, multi_turn=True))
    await transport.prewarm()

    first = await transport.run("task-1", on_status=lambda _s: None, on_progress=None)

    assert first.classification == "completed"
    assert factory.processes[0].returncode is not None

    second = await transport.run("task-2", on_status=lambda _s: None, on_progress=None)

    assert second.classification == "completed"
    assert len(factory.processes) == 2
    assert transport._preflight.calls == 2  # type: ignore[attr-defined]
    assert transport._protocol_probe.calls == 2  # type: ignore[attr-defined]


async def test_redaction_set_survives_a_full_turn_of_steers(tmp_path: Path) -> None:
    """Eight steers must not evict the still-active work order from redaction."""
    peer = _Peer(
        tmp_path,
        hold_completion=True,
        complete_on_steer=False,
        final_text="上一单是：机密工单甲",
    )
    transport, _factory = _transport(tmp_path, peer)
    run = asyncio.create_task(
        transport.run("机密工单甲", on_status=lambda _s: None, on_progress=None)
    )
    await peer.turn_started.wait()
    for index in range(8):
        steer = await transport.steer(f"追加约束-{index}")
        assert steer.code == "accepted"
    peer.complete()
    result = await run

    assert result.classification == "completed"
    text = result.content["result"]["final_message"]["text"]
    assert "机密工单甲" not in text
    assert "[REDACTED]" in text


async def test_sensitive_input_pressure_recycles_the_warm_thread(tmp_path: Path) -> None:
    """The redaction set never shrinks while a thread lives; pressure recycles instead."""
    transport, factory = _warm_transport(tmp_path, lambda: _Peer(tmp_path, multi_turn=True))
    await transport.prewarm()

    for index in range(8):
        result = await transport.run(f"工单-{index}", on_status=lambda _s: None, on_progress=None)
        assert result.classification == "completed"

    assert factory.processes[0].returncode is not None

    ninth = await transport.run("工单-八", on_status=lambda _s: None, on_progress=None)

    assert ninth.classification == "completed"
    assert len(factory.processes) == 2
