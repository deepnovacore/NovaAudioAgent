from __future__ import annotations

import asyncio
import hashlib
import inspect
import os
import signal
import stat
import sys
from contextlib import suppress
from pathlib import Path
from typing import Any, Mapping

import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.events import WakeReason
from nova_audio_agent.executors.codex import (
    CodexAdapter,
    CodexProcessStatus,
    CodexRunDeadline,
    CodexTransportResult,
)
from nova_audio_agent.executors import codex_preflight
from nova_audio_agent.executors import codex_transport
from nova_audio_agent.executors.codex_preflight import (
    CODEX_PERMISSION_PROFILE_TOML,
    CodexPreflightReport,
)
from nova_audio_agent.executors.codex_transport import (
    FINAL_MESSAGE_BYTE_LIMIT,
    FINAL_MESSAGE_TEXT_LIMIT,
    TERMINATE_GRACE,
    CodexTransport,
)
from nova_audio_agent.ports import DelegateRequest, DispatchContext, bind_delegate


WORK_ORDER = "create exactly one sentinel file"
API_KEY = "not-a-real-api-token"
SHAPED_TOKEN = "".join(("s", "k-proj-abcdefghijklmnopqrstuvwxyz012345"))
SHAPED_AUTH_TOKEN = "".join(("s", "k-proj-auth-json-secret-0123456789"))
COMPLETED_JSONL = (
    b'{"type":"thread.started","thread_id":"discard"}\n'
    b'{"type":"turn.started"}\n'
    b'{"type":"item.completed","item":{"command":"discard"}}\n'
    b'{"type":"turn.completed"}\n'
)


def _stream(data: bytes) -> asyncio.StreamReader:
    stream = asyncio.StreamReader()
    stream.feed_data(data)
    stream.feed_eof()
    return stream


class _FakeStdin:
    def __init__(self) -> None:
        self.writes: list[bytes] = []
        self.closed = False
        self.wait_closed_calls = 0

    def write(self, data: bytes) -> None:
        self.writes.append(data)

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        self.closed = True

    async def wait_closed(self) -> None:
        self.wait_closed_calls += 1


class _BlockingStdin(_FakeStdin):
    def __init__(self) -> None:
        super().__init__()
        self.drain_started = asyncio.Event()
        self.release = asyncio.Event()

    async def drain(self) -> None:
        self.drain_started.set()
        await self.release.wait()


class _FakeSubprocessTransport:
    def __init__(self) -> None:
        self._closing = False

    def get_pipe_transport(self, descriptor: int) -> None:
        return None

    def is_closing(self) -> bool:
        return self._closing

    def close(self) -> None:
        self._closing = True


class _FakeProcess:
    def __init__(
        self,
        *,
        stdout: bytes = COMPLETED_JSONL,
        stderr: bytes = b"",
        returncode: int = 0,
    ) -> None:
        self.stdin = _FakeStdin()
        self.stdout = _stream(stdout)
        self.stderr = _stream(stderr)
        self._configured_returncode = returncode
        self.returncode: int | None = None
        self.pid = 43210
        self.wait_calls = 0
        self.terminate_calls = 0
        self.kill_calls = 0
        self.wait_started = asyncio.Event()
        self.wait_release: asyncio.Event | None = None
        self._transport = _FakeSubprocessTransport()

    async def wait(self) -> int:
        self.wait_calls += 1
        self.wait_started.set()
        if self.wait_release is not None:
            await self.wait_release.wait()
        self.returncode = self._configured_returncode
        return self._configured_returncode

    def terminate(self) -> None:
        self.terminate_calls += 1
        self.returncode = -15

    def kill(self) -> None:
        self.kill_calls += 1
        self.returncode = -9


class _BlockedUntilKilledProcess(_FakeProcess):
    def __init__(self) -> None:
        super().__init__()
        self._killed = asyncio.Event()

    async def wait(self) -> int:
        self.wait_calls += 1
        self.wait_started.set()
        await self._killed.wait()
        assert self.returncode is not None
        return self.returncode

    def terminate(self) -> None:
        self.terminate_calls += 1

    def kill(self) -> None:
        self.kill_calls += 1
        self.returncode = -9
        self._killed.set()


class _ProcessFactory:
    def __init__(
        self,
        process: _FakeProcess,
        *,
        final_message: bytes = b"done",
    ) -> None:
        self.process = process
        self.final_message = final_message
        self.calls: list[tuple[tuple[str, ...], dict[str, Any]]] = []
        self.started = asyncio.Event()

    async def __call__(self, *argv: str, **kwargs: Any) -> _FakeProcess:
        self.calls.append((argv, kwargs))
        output_path = Path(argv[argv.index("-o") + 1])
        assert stat.S_IMODE(output_path.stat().st_mode) == 0o600
        output_path.write_bytes(self.final_message)
        self.started.set()
        return self.process


class _FailingProcessFactory:
    def __init__(self, failure: BaseException) -> None:
        self.failure = failure
        self.calls = 0
        self.output_paths: list[Path] = []

    async def __call__(self, *argv: str, **kwargs: Any) -> _FakeProcess:
        self.calls += 1
        self.output_paths.append(Path(argv[argv.index("-o") + 1]))
        raise self.failure


class _ReplacingProcessFactory(_ProcessFactory):
    def __init__(self, process: _FakeProcess, target: Path) -> None:
        super().__init__(process, final_message=b"safe-original")
        self.target = target

    async def __call__(self, *argv: str, **kwargs: Any) -> _FakeProcess:
        process = await super().__call__(*argv, **kwargs)
        output_path = Path(argv[argv.index("-o") + 1])
        self.output_path = output_path
        output_path.unlink()
        output_path.symlink_to(self.target)
        return process


class _RenamingProcessFactory(_ProcessFactory):
    def __init__(self, process: _FakeProcess, renamed: Path) -> None:
        super().__init__(process, final_message=b"raw-private-result")
        self.renamed = renamed

    async def __call__(self, *argv: str, **kwargs: Any) -> _FakeProcess:
        process = await super().__call__(*argv, **kwargs)
        Path(argv[argv.index("-o") + 1]).rename(self.renamed)
        return process


class _UnlinkingProcessFactory(_ProcessFactory):
    async def __call__(self, *argv: str, **kwargs: Any) -> _FakeProcess:
        process = await super().__call__(*argv, **kwargs)
        self.output_path = Path(argv[argv.index("-o") + 1])
        self.output_path.unlink()
        return process


class _DirectoryReplacingProcessFactory(_ProcessFactory):
    async def __call__(self, *argv: str, **kwargs: Any) -> _FakeProcess:
        process = await super().__call__(*argv, **kwargs)
        self.output_path = Path(argv[argv.index("-o") + 1])
        self.output_path.unlink()
        self.output_path.mkdir()
        return process


class _ReadOnlyWorkspaceProcessFactory(_ProcessFactory):
    async def __call__(self, *argv: str, **kwargs: Any) -> _FakeProcess:
        process = await super().__call__(*argv, **kwargs)
        self.output_path = Path(argv[argv.index("-o") + 1])
        Path(kwargs["cwd"]).chmod(0o555)
        return process


class _ImmediateTimeout:
    async def __call__(
        self,
        tasks: tuple[asyncio.Task[object], ...],
        timeout: float,
    ) -> tuple[object, ...]:
        assert 0 < timeout <= 510.0
        await asyncio.sleep(0)
        raise TimeoutError


class _DeadlineWaiter:
    def __init__(self, clock: VirtualClock) -> None:
        self.clock = clock
        self.timeouts: list[float] = []

    async def __call__(
        self,
        tasks: tuple[asyncio.Task[object], ...],
        timeout: float,
    ) -> tuple[object, ...]:
        self.timeouts.append(timeout)
        self.clock.advance_to(self.clock.now() + timeout)
        raise TimeoutError


class _CleanupRecorder:
    def __init__(
        self,
        *,
        stop: str = "kill",
        exit_code: int = -9,
    ) -> None:
        self.stop = stop
        self.exit_code = exit_code
        self.calls: list[float] = []

    async def __call__(
        self,
        process: _FakeProcess,
        tasks: tuple[asyncio.Task[object], ...],
        streams: tuple[asyncio.StreamReader, ...],
        *,
        grace: float,
    ) -> tuple[bool, codex_preflight.ProcessGroupCleanupResult]:
        self.calls.append(grace)
        process.returncode = self.exit_code
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        return False, codex_preflight.ProcessGroupCleanupResult(
            leader_stop=self.stop,  # type: ignore[arg-type]
            group_stop=self.stop,  # type: ignore[arg-type]
            leader_exited=True,
            group_gone=True,
        )


class _FailingCleanup:
    def __init__(self, failure: BaseException) -> None:
        self.failure = failure

    async def __call__(
        self, *args: Any, **kwargs: Any
    ) -> tuple[bool, codex_preflight.ProcessGroupCleanupResult]:
        raise self.failure


class _UnverifiedCleanup:
    async def __call__(
        self, *args: Any, **kwargs: Any
    ) -> tuple[bool, codex_preflight.ProcessGroupCleanupResult]:
        return False, codex_preflight.ProcessGroupCleanupResult(
            leader_stop="none",
            group_stop="kill",
            leader_exited=True,
            group_gone=False,
        )


def _preflight_report() -> CodexPreflightReport:
    return CodexPreflightReport(
        version="0.145.0",
        root_matches=True,
        mount="workspace_only",
        subprocess="contained",
        network="blocked",
        credential_present=True,
        credential_identity="api_key",
        credential_policy="process_only",
        limits={"cpu": "finite", "as": "unbounded", "nofile": "finite"},
    )


class _Preflight:
    async def run(self, *, timeout: float) -> CodexPreflightReport:
        return _preflight_report()


class _EnvelopeWorker:
    def __init__(self, content: object) -> None:
        self.content = content

    async def preflight(
        self,
        *,
        deadline: CodexRunDeadline | None = None,
    ) -> Mapping[str, Any]:
        return _preflight_report().to_mapping()

    async def run(
        self,
        work_order: str,
        *,
        on_status: Any,
        deadline: CodexRunDeadline | None = None,
    ) -> CodexTransportResult:
        on_status(CodexProcessStatus(running=True, exited=False))
        on_status(
            CodexProcessStatus(
                running=False,
                exited=True,
                terminal="completed",
                exit_code=0,
            )
        )
        return CodexTransportResult(
            classification="completed",
            code="completed",
            content=self.content,  # type: ignore[arg-type]
        )


class _DictSubclass(dict[str, Any]):
    pass


class _StringSubclass(str):
    pass


def _exact_content() -> dict[str, Any]:
    return {
        "events": [
            {"type": "thread.started"},
            {"type": "turn.started"},
            {"type": "turn.completed"},
        ],
        "protocol": {
            "thread_started": True,
            "turn_started": True,
            "terminal": "completed",
            "transport_closed": True,
            "unknown_event_count": 0,
        },
        "process": {"started": True, "exit_code": 0, "stop": "none"},
        "result": {
            "final_message": {
                "text": "safe",
                "original_chars": 4,
                "truncated": False,
                "sha256": hashlib.sha256(b"safe").hexdigest(),
            }
        },
    }


def _transport(
    workspace: Path,
    factory: Any,
    *,
    environ: Mapping[str, str] | None = None,
    waiter: Any = None,
    cleanup: Any = None,
    clock: VirtualClock | None = None,
) -> CodexTransport:
    kwargs: dict[str, Any] = {}
    if waiter is not None:
        kwargs["_waiter"] = waiter
    if cleanup is not None:
        kwargs["_cleanup"] = cleanup
    if clock is not None:
        kwargs["_clock"] = clock
    return CodexTransport(
        binary="codex-custom",
        workspace=workspace,
        api_key=API_KEY,
        preflight=_Preflight(),
        process_factory=factory,
        environ={} if environ is None else environ,
        **kwargs,
    )


def _ctx() -> DispatchContext:
    clock = VirtualClock(start=9.0)
    delegate = bind_delegate(
        DelegateRequest(
            executor="codex",
            op="run",
            request={"work_order": WORK_ORDER},
            origin_ref="conversation:transport",
        ),
        wake_reason=WakeReason(
            kind="user_input",
            priority=100,
            routing_class="user_awaited",
        ),
        op=CodexAdapter.manifest.ops[0],
        now=clock.now(),
        delegate_id="d-codex-transport",
    )
    return DispatchContext(clock=clock, delegate=delegate)


async def test_exact_argv_uses_fixed_root_options_and_private_output(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    factory = _ProcessFactory(_FakeProcess())
    transport = _transport(workspace, factory)

    statuses: list[CodexProcessStatus] = []
    result = await transport.run(WORK_ORDER, on_status=statuses.append)

    assert result.classification == "completed"
    assert len(factory.calls) == 1
    argv, kwargs = factory.calls[0]
    output_path = argv[argv.index("-o") + 1]
    assert argv == (
        "codex-custom",
        "-a",
        "never",
        "--disable",
        "hooks",
        "--disable",
        "multi_agent",
        "--disable",
        "apps",
        "--disable",
        "plugins",
        "--disable",
        "remote_plugin",
        "--disable",
        "plugin_sharing",
        "--disable",
        "tool_suggest",
        "-c",
        'web_search="disabled"',
        "-c",
        'default_permissions="nova_audio_agent"',
        "-c",
        f"permissions.nova_audio_agent={CODEX_PERMISSION_PROFILE_TOML}",
        "-c",
        'shell_environment_policy.inherit="core"',
        "-c",
        'shell_environment_policy.include_only=["PATH","LANG","LC_ALL","TERM"]',
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "-C",
        str(workspace),
        "-o",
        output_path,
        "-",
    )
    assert WORK_ORDER not in repr(argv)
    assert not Path(output_path).exists()
    assert kwargs["cwd"] == workspace
    assert kwargs["stdin"] == asyncio.subprocess.PIPE
    assert kwargs["stdout"] == asyncio.subprocess.PIPE
    assert kwargs["stderr"] == asyncio.subprocess.PIPE
    assert kwargs["start_new_session"] is (os.name == "posix")
    assert "shell" not in kwargs


async def test_work_order_is_written_once_to_stdin_then_closed(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    process = _FakeProcess()
    factory = _ProcessFactory(process)
    transport = _transport(workspace, factory)

    await transport.run(f"  {WORK_ORDER}  ", on_status=lambda _: None)

    assert process.stdin.writes == [WORK_ORDER.encode("utf-8")]
    assert process.stdin.closed is True
    assert process.stdin.wait_closed_calls == 1


async def test_environment_is_a_strict_parent_allowlist(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    factory = _ProcessFactory(_FakeProcess())
    environ = {
        "PATH": "/safe/bin",
        "HOME": "/safe/home",
        "CODEX_HOME": "/safe/codex",
        "LANG": "zh_CN.UTF-8",
        "LC_ALL": "C",
        "TERM": "xterm",
        "SSL_CERT_FILE": "/safe/cert.pem",
        "SSL_CERT_DIR": "/safe/certs",
        "REQUESTS_CA_BUNDLE": "/safe/requests.pem",
        "CURL_CA_BUNDLE": "/safe/curl.pem",
        "NOVA_AUDIO_AGENT_HA_TOKEN": "ha-secret",
        "NOVA_AUDIO_AGENT_FAST_MODEL_API_KEY": "model-secret",
        "TAVILY_API_KEY": "search-secret",
        "OPENAI_API_KEY": "provider-secret",
        "UNRELATED": "discard",
    }
    transport = _transport(workspace, factory, environ=environ)

    await transport.run(WORK_ORDER, on_status=lambda _: None)

    _, kwargs = factory.calls[0]
    assert kwargs["env"] == {
        "PATH": "/safe/bin",
        "HOME": "/safe/home",
        "CODEX_HOME": "/safe/codex",
        "LANG": "zh_CN.UTF-8",
        "LC_ALL": "C",
        "TERM": "xterm",
        "SSL_CERT_FILE": "/safe/cert.pem",
        "SSL_CERT_DIR": "/safe/certs",
        "REQUESTS_CA_BUNDLE": "/safe/requests.pem",
        "CURL_CA_BUNDLE": "/safe/curl.pem",
        "CODEX_API_KEY": API_KEY,
    }
    assert "ha-secret" not in repr(factory.calls)
    assert "model-secret" not in repr(factory.calls)
    assert "search-secret" not in repr(factory.calls)
    assert "provider-secret" not in repr(factory.calls)


async def test_lifecycle_completed_has_separate_protocol_and_process_evidence(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    process = _FakeProcess()
    factory = _ProcessFactory(process, final_message=b"completed safely")
    statuses: list[CodexProcessStatus] = []

    result = await _transport(workspace, factory).run(
        WORK_ORDER,
        on_status=statuses.append,
    )

    assert result.classification == "completed"
    assert result.code == "completed"
    assert result.content == {
        "events": [
            {"type": "thread.started"},
            {"type": "turn.started"},
            {"type": "internal_activity", "count": 1},
            {"type": "turn.completed"},
        ],
        "protocol": {
            "thread_started": True,
            "turn_started": True,
            "terminal": "completed",
            "transport_closed": True,
            "unknown_event_count": 0,
        },
        "process": {"started": True, "exit_code": 0, "stop": "none"},
        "result": {
            "final_message": {
                "text": "completed safely",
                "original_chars": 16,
                "truncated": False,
                "sha256": hashlib.sha256(b"completed safely").hexdigest(),
            }
        },
    }
    assert statuses == [
        CodexProcessStatus(running=True, exited=False),
        CodexProcessStatus(
            running=False,
            exited=True,
            terminal="completed",
            exit_code=0,
        ),
    ]


async def test_completed_lifecycle_confirms_no_residual_process_group(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    cleanup = _CleanupRecorder(stop="none", exit_code=0)

    result = await _transport(
        workspace,
        _ProcessFactory(_FakeProcess()),
        cleanup=cleanup,
    ).run(WORK_ORDER, on_status=lambda _: None)

    assert result.classification == "completed"
    assert cleanup.calls == [TERMINATE_GRACE]


async def test_unverified_shared_cleanup_uses_independent_verified_fallback(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    fallback_calls = 0

    async def fallback(
        *args: Any, **kwargs: Any
    ) -> tuple[bool, codex_preflight.ProcessGroupCleanupResult]:
        nonlocal fallback_calls
        fallback_calls += 1
        return False, codex_preflight.ProcessGroupCleanupResult(
            leader_stop="none",
            group_stop="none",
            leader_exited=True,
            group_gone=True,
        )

    monkeypatch.setattr(codex_transport, "_fallback_process_cleanup", fallback)

    result = await _transport(
        workspace,
        _ProcessFactory(_FakeProcess()),
        cleanup=_UnverifiedCleanup(),
    ).run(WORK_ORDER, on_status=lambda _: None)

    assert fallback_calls == 1
    assert result.classification == "completed"


async def test_unverified_shared_cleanup_stays_unknown_if_fallback_unverified(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    fallback_calls = 0

    async def fallback(
        *args: Any, **kwargs: Any
    ) -> tuple[bool, codex_preflight.ProcessGroupCleanupResult]:
        nonlocal fallback_calls
        fallback_calls += 1
        return False, codex_preflight.ProcessGroupCleanupResult(
            leader_stop="kill",
            group_stop="kill",
            leader_exited=False,
            group_gone=False,
        )

    monkeypatch.setattr(codex_transport, "_fallback_process_cleanup", fallback)

    result = await _transport(
        workspace,
        _ProcessFactory(_FakeProcess()),
        cleanup=_UnverifiedCleanup(),
    ).run(WORK_ORDER, on_status=lambda _: None)

    assert fallback_calls == 1
    assert result.classification == "uncertain"
    assert result.code == "transport_failure"
    assert result.content["process"]["stop"] == "none"


@pytest.mark.parametrize(
    ("stdout", "returncode", "expected_code", "terminal"),
    [
        (
            COMPLETED_JSONL.replace(b"turn.completed", b"turn.failed"),
            0,
            "turn_failed",
            "failed",
        ),
        (COMPLETED_JSONL, 7, "nonzero_exit", "completed"),
        (
            b'{"type":"thread.started"}\n{"type":"turn.started"}\n',
            0,
            "missing_terminal",
            None,
        ),
        (b'{"type":', 0, "malformed_jsonl", None),
        (b"x" * (64 * 1024 + 1), 0, "stdout_too_large", None),
    ],
)
async def test_lifecycle_uncertain_outcomes_are_typed(
    tmp_path: Path,
    stdout: bytes,
    returncode: int,
    expected_code: str,
    terminal: str | None,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    process = _FakeProcess(stdout=stdout, returncode=returncode)
    factory = _ProcessFactory(process)
    cleanup = _CleanupRecorder(stop="none", exit_code=returncode)
    statuses: list[CodexProcessStatus] = []

    result = await _transport(workspace, factory, cleanup=cleanup).run(
        WORK_ORDER,
        on_status=statuses.append,
    )

    assert result.classification == "uncertain"
    assert result.code == expected_code
    assert result.content["process"]["exit_code"] == returncode
    assert result.content["protocol"]["terminal"] == terminal
    assert result.content["protocol"]["transport_closed"] is (
        expected_code in {"turn_failed", "nonzero_exit", "missing_terminal"}
    )
    assert statuses[-1] == CodexProcessStatus(
        running=False,
        exited=True,
        terminal=terminal,
        exit_code=returncode,
    )
    assert WORK_ORDER not in repr(result)


async def test_lifecycle_oversized_stderr_is_discarded_and_uncertain(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    sentinel = b"raw-stderr-secret"
    process = _FakeProcess(stderr=sentinel + b"x" * (64 * 1024))
    factory = _ProcessFactory(process)
    cleanup = _CleanupRecorder(stop="terminate", exit_code=-15)

    result = await _transport(workspace, factory, cleanup=cleanup).run(
        WORK_ORDER,
        on_status=lambda _: None,
    )

    assert result.classification == "uncertain"
    assert result.code == "stderr_too_large"
    assert sentinel.decode() not in repr(result)


async def test_outcome_spawn_failure_is_refused_without_retry_or_status(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    sentinel = "raw-spawn-error-with-token"
    factory = _FailingProcessFactory(OSError(sentinel))
    statuses: list[CodexProcessStatus] = []

    result = await _transport(workspace, factory).run(
        WORK_ORDER,
        on_status=statuses.append,
    )

    assert result.classification == "refused"
    assert result.code == "spawn_failed"
    assert result.content == {}
    assert factory.calls == 1
    assert statuses == []
    assert sentinel not in repr(result)
    assert all(not path.exists() for path in factory.output_paths)


async def test_timeout_reserves_cleanup_then_uses_five_second_grace_and_kill(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    process = _FakeProcess()
    process.wait_release = asyncio.Event()
    factory = _ProcessFactory(process)
    cleanup = _CleanupRecorder(stop="kill", exit_code=-9)
    statuses: list[CodexProcessStatus] = []

    result = await _transport(
        workspace,
        factory,
        waiter=_ImmediateTimeout(),
        cleanup=cleanup,
    ).run(WORK_ORDER, on_status=statuses.append)

    assert result.classification == "uncertain"
    assert result.code == "timeout"
    assert result.content["process"] == {
        "started": True,
        "exit_code": -9,
        "stop": "kill",
    }
    assert cleanup.calls == [TERMINATE_GRACE]
    assert statuses[-1].exited is True


async def test_absolute_deadline_reserves_cleanup_and_classifies_boundary_expiry(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    clock = VirtualClock()
    process = _FakeProcess()
    process.wait_release = asyncio.Event()
    waiter = _DeadlineWaiter(clock)

    class _BoundaryCleanup(_CleanupRecorder):
        async def __call__(
            self,
            process: _FakeProcess,
            tasks: tuple[asyncio.Task[object], ...],
            streams: tuple[asyncio.StreamReader, ...],
            *,
            grace: float,
        ) -> tuple[bool, codex_preflight.ProcessGroupCleanupResult]:
            result = await super().__call__(process, tasks, streams, grace=grace)
            clock.advance_to(540.0)
            return result

    cleanup = _BoundaryCleanup()
    result = await _transport(
        workspace,
        _ProcessFactory(process),
        waiter=waiter,
        cleanup=cleanup,
        clock=clock,
    ).run(
        WORK_ORDER,
        on_status=lambda _: None,
        deadline=CodexRunDeadline(540.0, clock),
    )

    assert waiter.timeouts == [510.0]
    assert cleanup.calls == [5.0]
    assert clock.now() == 540.0
    assert result.classification == "uncertain"
    assert result.code == "adapter_timeout"
    assert result.content["process"]["started"] is True
    assert API_KEY not in repr(result)
    assert str(workspace) not in repr(result)


async def test_final_output_cleanup_cannot_turn_expired_run_into_success(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    clock = VirtualClock()
    real_finalize = codex_transport._finalize_private_output

    def expire_during_finalize(output: Any) -> bool:
        clock.advance_to(540.0)
        return real_finalize(output)

    monkeypatch.setattr(
        codex_transport,
        "_finalize_private_output",
        expire_during_finalize,
    )
    result = await _transport(
        workspace,
        _ProcessFactory(_FakeProcess()),
        clock=clock,
    ).run(
        WORK_ORDER,
        on_status=lambda _: None,
        deadline=CodexRunDeadline(540.0, clock),
    )

    assert result.classification == "uncertain"
    assert result.code == "adapter_timeout"
    assert result.content["process"]["started"] is True
    assert not any(workspace.glob(".nova-audio-agent-codex-result-*"))
    assert API_KEY not in repr(result)
    assert str(workspace) not in repr(result)


async def test_timeout_also_bounds_blocking_stdin_delivery(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    process = _FakeProcess()
    process.stdin = _BlockingStdin()
    factory = _ProcessFactory(process)
    cleanup = _CleanupRecorder(stop="kill", exit_code=-9)

    async with asyncio.timeout(0.2):
        result = await _transport(
            workspace,
            factory,
            waiter=_ImmediateTimeout(),
            cleanup=cleanup,
        ).run(WORK_ORDER, on_status=lambda _: None)

    assert result.classification == "uncertain"
    assert result.code == "timeout"
    assert process.stdin.writes == [WORK_ORDER.encode()]
    assert process.stdin.closed is True
    assert process.stdin.wait_closed_calls == 1
    assert cleanup.calls == [TERMINATE_GRACE]


async def test_cleanup_failure_uses_independent_bounded_fallback(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    process = _FakeProcess()
    process.wait_release = asyncio.Event()
    fallback_called = False

    async def fallback(
        *args: Any, **kwargs: Any
    ) -> tuple[bool, codex_preflight.ProcessGroupCleanupResult]:
        nonlocal fallback_called
        fallback_called = True
        process.returncode = -15
        return False, codex_preflight.ProcessGroupCleanupResult(
            leader_stop="terminate",
            group_stop="terminate",
            leader_exited=True,
            group_gone=True,
        )

    monkeypatch.setattr(codex_transport, "_fallback_process_cleanup", fallback)
    result = await _transport(
        workspace,
        _ProcessFactory(process),
        waiter=_ImmediateTimeout(),
        cleanup=_FailingCleanup(RuntimeError("raw-cleanup-error")),
    ).run(WORK_ORDER, on_status=lambda _: None)

    assert fallback_called is True
    assert result.classification == "uncertain"
    assert result.code == "timeout"
    assert result.content["process"]["stop"] == "terminate"
    assert "raw-cleanup-error" not in repr(result)


async def test_cleanup_failure_never_claims_kill_without_verified_stop(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    process = _FakeProcess()
    process.wait_release = asyncio.Event()

    async def failed_fallback(
        *args: Any, **kwargs: Any
    ) -> tuple[bool, codex_preflight.ProcessGroupCleanupResult]:
        return False, codex_preflight.ProcessGroupCleanupResult(
            leader_stop="kill",
            group_stop="kill",
            leader_exited=False,
            group_gone=False,
        )

    monkeypatch.setattr(
        codex_transport,
        "_fallback_process_cleanup",
        failed_fallback,
    )
    result = await _transport(
        workspace,
        _ProcessFactory(process),
        waiter=_ImmediateTimeout(),
        cleanup=_FailingCleanup(RuntimeError("raw-cleanup-error")),
    ).run(WORK_ORDER, on_status=lambda _: None)

    assert result.classification == "uncertain"
    assert result.code == "transport_failure"
    assert result.content["process"]["stop"] == "none"


async def test_cleanup_fallback_is_shielded_before_cancellation_reraises(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    process = _FakeProcess()
    process.wait_release = asyncio.Event()
    fallback_started = asyncio.Event()
    fallback_release = asyncio.Event()
    fallback_finished = asyncio.Event()

    async def fallback(
        *args: Any, **kwargs: Any
    ) -> tuple[bool, codex_preflight.ProcessGroupCleanupResult]:
        fallback_started.set()
        await fallback_release.wait()
        fallback_finished.set()
        process.returncode = -15
        return False, codex_preflight.ProcessGroupCleanupResult(
            leader_stop="terminate",
            group_stop="terminate",
            leader_exited=True,
            group_gone=True,
        )

    monkeypatch.setattr(codex_transport, "_fallback_process_cleanup", fallback)
    task = asyncio.create_task(
        _transport(
            workspace,
            _ProcessFactory(process),
            waiter=_ImmediateTimeout(),
            cleanup=_FailingCleanup(RuntimeError("cleanup failed")),
        ).run(WORK_ORDER, on_status=lambda _: None)
    )
    await fallback_started.wait()
    task.cancel()
    fallback_release.set()

    with pytest.raises(asyncio.CancelledError):
        await task
    assert fallback_finished.is_set()


@pytest.mark.parametrize(
    "failure",
    [asyncio.CancelledError(), KeyboardInterrupt(), SystemExit()],
)
async def test_cleanup_failure_preserves_process_control_exception(
    tmp_path: Path,
    failure: BaseException,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    process = _FakeProcess()
    process.wait_release = asyncio.Event()

    with pytest.raises(type(failure)):
        await _transport(
            workspace,
            _ProcessFactory(process),
            waiter=_ImmediateTimeout(),
            cleanup=_FailingCleanup(failure),
        ).run(WORK_ORDER, on_status=lambda _: None)


async def test_cancellation_cleans_up_then_reraises_original_cancellation(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    process = _FakeProcess()
    process.wait_release = asyncio.Event()
    factory = _ProcessFactory(process)
    cleanup = _CleanupRecorder(stop="terminate", exit_code=-15)
    transport = _transport(workspace, factory, cleanup=cleanup)
    statuses: list[CodexProcessStatus] = []

    task = asyncio.create_task(transport.run(WORK_ORDER, on_status=statuses.append))
    await process.wait_started.wait()
    output_path = Path(factory.calls[0][0][factory.calls[0][0].index("-o") + 1])
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    assert cleanup.calls == [TERMINATE_GRACE]
    assert statuses[-1] == CodexProcessStatus(
        running=False,
        exited=True,
        terminal=None,
        exit_code=-15,
    )
    assert not output_path.exists()


async def test_status_callback_failure_after_spawn_still_cleans_process(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    process = _FakeProcess()
    process.wait_release = asyncio.Event()
    factory = _ProcessFactory(process)
    cleanup = _CleanupRecorder(stop="terminate", exit_code=-15)
    statuses: list[CodexProcessStatus] = []

    def on_status(status: CodexProcessStatus) -> None:
        if status.running:
            raise RuntimeError("raw-callback-sentinel")
        statuses.append(status)

    result = await _transport(workspace, factory, cleanup=cleanup).run(
        WORK_ORDER,
        on_status=on_status,
    )

    assert result.classification == "uncertain"
    assert result.code == "stream_failure"
    assert cleanup.calls == [TERMINATE_GRACE]
    assert statuses == [
        CodexProcessStatus(
            running=False,
            exited=True,
            terminal=None,
            exit_code=-15,
        )
    ]
    assert "raw-callback-sentinel" not in repr(result)


async def test_outcome_final_message_is_bounded_normalized_and_redacted(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    home = tmp_path / "home-secret"
    shaped = SHAPED_TOKEN
    private_key = "".join(
        ("-----BEGIN PRIVATE ", "KEY-----\nSECRET\n-----END PRIVATE ", "KEY-----")
    )
    tail = "ordinary prose " * (FINAL_MESSAGE_TEXT_LIMIT // 8)
    raw = f"e\u0301\u0000 {API_KEY} {shaped} {private_key} {home}/file {workspace}/src {tail}"
    factory = _ProcessFactory(_FakeProcess(), final_message=raw.encode())
    transport = _transport(
        workspace,
        factory,
        environ={"HOME": str(home), "PATH": "/bin"},
    )

    result = await transport.run(WORK_ORDER, on_status=lambda _: None)

    final = result.content["result"]["final_message"]
    assert len(final["text"]) <= FINAL_MESSAGE_TEXT_LIMIT
    assert final["truncated"] is True
    assert final["original_chars"] > FINAL_MESSAGE_TEXT_LIMIT
    assert len(final["sha256"]) == 64
    rendered = repr(result)
    for secret in (API_KEY, shaped, "SECRET", str(home), str(workspace), "\u0000"):
        assert secret not in rendered
    assert "[REDACTED]" in final["text"]
    assert "[PRIVATE_KEY]" in final["text"]
    assert "[HOME]" in final["text"]
    assert "[WORKSPACE]" in final["text"]
    assert final["text"].startswith("é ")


@pytest.mark.parametrize(
    "credential_text",
    [
        '{"access_token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJub3ZhIn0.signaturevalue"}',
        "{ 'refresh_token' : 'opaque_REFRESH_token_0123456789abcdefghijklmnopqrstuvwxyz' }",
        r"{\"id_token\"\t:\t\"eyJhbGciOiJSUzI1NiJ9.payloadsegment.signaturesegment\"}",
        f'  "API_KEY"  :  "{SHAPED_AUTH_TOKEN}" ',
        "ACCESS_TOKEN = opaqueaccesstoken0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJjb2RleCJ9.abcdefghijklmnopqrstuvwxyz",
        "opaqueRefreshToken0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijk",
        "opaquerefreshtoken012345678901234567890123456789abcdefghijklmnop",
    ],
)
def test_auth_redaction_removes_saved_login_credentials_before_digest(
    tmp_path: Path,
    credential_text: str,
) -> None:
    output = tmp_path / "result"
    output.write_text(f"before {credential_text} after")

    final = codex_transport._read_final_message(
        output,
        descriptor=None,
        credentials=(),
        home=None,
        workspace=tmp_path / "workspace",
    )

    assert credential_text not in final["text"]
    for secret_part in (
        "eyJhbGci",
        "signaturevalue",
        "opaque_REFRESH",
        "".join(("s", "k-proj-auth")),
        "opaqueaccess",
        "opaqueRefresh",
        "opaquerefresh",
    ):
        assert secret_part not in final["text"]
    assert "[REDACTED]" in final["text"]
    assert final["sha256"] == hashlib.sha256(final["text"].encode()).hexdigest()


def test_auth_redaction_replaces_known_exact_short_credential_first(
    tmp_path: Path,
) -> None:
    output = tmp_path / "result"
    output.write_text("prefix exact-short-token suffix")

    final = codex_transport._read_final_message(
        output,
        descriptor=None,
        credentials=("exact-short-token",),
        home=None,
        workspace=tmp_path / "workspace",
    )

    assert final["text"] == "prefix [REDACTED] suffix"


async def test_outcome_final_message_over_hard_byte_limit_is_uncertain(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    factory = _ProcessFactory(
        _FakeProcess(),
        final_message=b"x" * (FINAL_MESSAGE_BYTE_LIMIT + 1),
    )

    result = await _transport(workspace, factory).run(
        WORK_ORDER,
        on_status=lambda _: None,
    )

    assert result.classification == "uncertain"
    assert result.code == "final_message_too_large"
    assert "final_message" not in repr(result.content)


def test_final_message_fallback_does_not_swallow_process_control_exceptions(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    output = tmp_path / "result"
    output.write_bytes(b"unused")

    def interrupt(*args: Any, **kwargs: Any) -> dict[str, Any]:
        raise KeyboardInterrupt

    monkeypatch.setattr(codex_transport, "_read_final_message", interrupt)

    with pytest.raises(KeyboardInterrupt):
        codex_transport._try_final_message(
            output,
            descriptor=None,
            credentials=(),
            home=None,
            workspace=tmp_path,
        )


def test_private_descriptor_reader_handles_short_reads(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    chunks = iter((b"hel", b"lo", b""))
    monkeypatch.setattr(os, "lseek", lambda *args: 0)
    monkeypatch.setattr(os, "read", lambda *args: next(chunks))

    result = codex_transport._read_final_message(
        tmp_path / "unused",
        descriptor=7,
        credentials=(),
        home=None,
        workspace=tmp_path,
    )

    assert result["text"] == "hello"
    assert result["original_chars"] == 5


def test_private_descriptor_short_reads_still_enforce_hard_bound(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    remaining = FINAL_MESSAGE_BYTE_LIMIT + 1

    def short_read(*args: Any) -> bytes:
        nonlocal remaining
        if remaining == 0:
            return b""
        size = min(997, remaining)
        remaining -= size
        return b"x" * size

    monkeypatch.setattr(os, "lseek", lambda *args: 0)
    monkeypatch.setattr(os, "read", short_read)

    with pytest.raises(Exception) as exc_info:
        codex_transport._read_final_message(
            tmp_path / "unused",
            descriptor=7,
            credentials=(),
            home=None,
            workspace=tmp_path,
        )

    assert getattr(exc_info.value, "code", None) == "final_message_too_large"


def test_private_output_cleanup_truncates_sparse_file_without_block_writes(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    private_output = codex_transport._create_private_output(tmp_path)
    os.ftruncate(private_output.descriptor, 16 * 1024 * 1024 * 1024)
    monkeypatch.setattr(
        os,
        "write",
        lambda *args: (_ for _ in ()).throw(AssertionError("must not block-write")),
    )

    assert codex_transport._finalize_private_output(private_output) is True
    assert not private_output.path.exists()


async def test_private_output_reader_does_not_follow_worker_replacement(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside_secret = tmp_path / "outside-secret"
    outside_secret.write_text("must-not-be-returned")
    factory = _ReplacingProcessFactory(_FakeProcess(), outside_secret)

    try:
        result = await _transport(workspace, factory).run(
            WORK_ORDER,
            on_status=lambda _: None,
        )

        assert result.classification == "uncertain"
        assert result.code == "transport_failure"
        assert "must-not-be-returned" not in repr(result)
        assert factory.output_path.is_symlink()
        assert outside_secret.read_text() == "must-not-be-returned"
    finally:
        factory.output_path.unlink(missing_ok=True)


async def test_private_output_rename_is_scrubbed_and_downgrades_completion(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    renamed = workspace / "renamed-result"
    factory = _RenamingProcessFactory(_FakeProcess(), renamed)
    try:
        result = await _transport(workspace, factory).run(
            WORK_ORDER,
            on_status=lambda _: None,
        )

        assert result.classification == "uncertain"
        assert result.code == "transport_failure"
        assert renamed.read_bytes() == b""
    finally:
        renamed.unlink(missing_ok=True)


async def test_private_output_already_unlinked_is_scrubbed_and_can_complete(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    factory = _UnlinkingProcessFactory(_FakeProcess())

    result = await _transport(workspace, factory).run(
        WORK_ORDER,
        on_status=lambda _: None,
    )

    assert result.classification == "completed"
    assert not factory.output_path.exists()


async def test_cancelled_run_scrubs_renamed_private_output_before_reraising(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    renamed = workspace / "cancelled-renamed-result"
    process = _FakeProcess()
    process.wait_release = asyncio.Event()
    factory = _RenamingProcessFactory(process, renamed)
    transport = _transport(
        workspace,
        factory,
        cleanup=_CleanupRecorder(stop="terminate", exit_code=-15),
    )
    task = asyncio.create_task(transport.run(WORK_ORDER, on_status=lambda _: None))
    await process.wait_started.wait()
    task.cancel()
    try:
        with pytest.raises(asyncio.CancelledError):
            await task
        assert renamed.read_bytes() == b""
    finally:
        renamed.unlink(missing_ok=True)


async def test_keyboard_interrupt_keeps_priority_but_scrubs_private_output(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    renamed = workspace / "interrupted-renamed-result"
    factory = _RenamingProcessFactory(_FakeProcess(), renamed)

    def interrupt(_: CodexProcessStatus) -> None:
        raise KeyboardInterrupt

    try:
        with pytest.raises(KeyboardInterrupt):
            await _transport(
                workspace,
                factory,
                cleanup=_CleanupRecorder(stop="terminate", exit_code=-15),
            ).run(WORK_ORDER, on_status=interrupt)
        assert renamed.read_bytes() == b""
    finally:
        renamed.unlink(missing_ok=True)


async def test_private_output_directory_replacement_is_left_and_fails_closed(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    factory = _DirectoryReplacingProcessFactory(_FakeProcess())
    try:
        result = await _transport(workspace, factory).run(
            WORK_ORDER,
            on_status=lambda _: None,
        )

        assert result.classification == "uncertain"
        assert result.code == "transport_failure"
        assert factory.output_path.is_dir()
    finally:
        factory.output_path.rmdir()


async def test_private_output_unlink_failure_downgrades_completion(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    factory = _ReadOnlyWorkspaceProcessFactory(_FakeProcess())
    try:
        result = await _transport(workspace, factory).run(
            WORK_ORDER,
            on_status=lambda _: None,
        )

        assert result.classification == "uncertain"
        assert result.code == "transport_failure"
    finally:
        workspace.chmod(0o755)
        factory.output_path.unlink(missing_ok=True)


async def test_adapter_integration_admits_only_exact_safe_transport_envelope(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    worker = _transport(
        workspace,
        _ProcessFactory(_FakeProcess(), final_message=b"safe final"),
    )

    handoff = await CodexAdapter(worker).dispatch(
        "run",
        {"work_order": WORK_ORDER},
        _ctx(),
    )

    assert handoff.outcome == "ok"
    assert handoff.trust == "untrusted_external"
    assert handoff.content["events"][-1] == {"type": "turn.completed"}
    assert handoff.content["protocol"]["transport_closed"] is True
    assert handoff.content["process"] == {
        "started": True,
        "exit_code": 0,
        "stop": "none",
    }
    assert handoff.content["result"]["final_message"]["text"] == "safe final"
    assert handoff.content["preflight"]["version"] == "0.145.0"
    assert handoff.content["goal_verification"] == "unverified"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda value: _DictSubclass(value),
        lambda value: {**value, "unexpected": "do-not-retain"},
        lambda value: {
            **value,
            "protocol": {**value["protocol"], "unknown_event_count": True},
        },
        lambda value: {
            **value,
            "process": {**value["process"], "exit_code": float("nan")},
        },
        lambda value: {
            **value,
            "result": {
                "final_message": {
                    **value["result"]["final_message"],
                    "text": _StringSubclass("unsafe-subclass"),
                }
            },
        },
    ],
    ids=[
        "dict-subclass",
        "extra-key",
        "bool-as-int",
        "nan",
        "str-subclass",
    ],
)
async def test_adapter_strictly_rejects_malformed_transport_envelope(
    mutate: Any,
) -> None:
    content = mutate(_exact_content())
    handoff = await CodexAdapter(_EnvelopeWorker(content)).dispatch(
        "run",
        {"work_order": WORK_ORDER},
        _ctx(),
    )

    assert (handoff.outcome, handoff.trust) == ("unknown", "untrusted_external")
    assert handoff.content["code"] == "invalid_worker_result"
    assert "do-not-retain" not in repr(handoff)
    assert "unsafe-subclass" not in repr(handoff)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda value: {
            **value,
            "process": {**value["process"], "exit_code": 7},
        },
        lambda value: {
            **value,
            "protocol": {**value["protocol"], "terminal": "failed"},
        },
        lambda value: {
            **value,
            "protocol": {**value["protocol"], "transport_closed": False},
        },
        lambda value: {
            **value,
            "events": [
                value["events"][1],
                value["events"][0],
                value["events"][2],
            ],
        },
        lambda value: {
            **value,
            "events": [
                value["events"][0],
                value["events"][1],
                value["events"][1],
                value["events"][2],
            ],
        },
    ],
    ids=[
        "exit-mismatch",
        "terminal-mismatch",
        "open-transport",
        "out-of-order",
        "duplicate-turn",
    ],
)
async def test_adapter_rejects_completed_evidence_that_contradicts_status(
    mutate: Any,
) -> None:
    handoff = await CodexAdapter(_EnvelopeWorker(mutate(_exact_content()))).dispatch(
        "run",
        {"work_order": WORK_ORDER},
        _ctx(),
    )

    assert (handoff.outcome, handoff.trust) == ("unknown", "untrusted_external")
    assert handoff.content["code"] == "invalid_worker_result"


async def test_shared_cleanup_helper_keeps_preflight_default_and_turn_grace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: list[float] = []

    async def fake_cleanup(
        process: object,
        tasks: tuple[asyncio.Task[object], ...],
        streams: tuple[asyncio.StreamReader, ...],
        *,
        grace: float,
    ) -> codex_preflight.ProcessGroupCleanupResult:
        observed.append(grace)
        return codex_preflight.ProcessGroupCleanupResult(
            leader_stop="none",
            group_stop="none",
            leader_exited=True,
            group_gone=True,
        )

    monkeypatch.setattr(codex_preflight, "_cleanup_process_group", fake_cleanup)
    process = object()
    assert (
        inspect.signature(codex_preflight._finish_process_cleanup).parameters["grace"].default
        == 0.1
    )

    first = await codex_preflight._finish_process_cleanup(  # type: ignore[arg-type]
        process,
        (),
        (),
    )
    second = await codex_preflight._finish_process_cleanup(  # type: ignore[arg-type]
        process,
        (),
        (),
        grace=TERMINATE_GRACE,
    )
    assert first[0] is False
    assert second[0] is False
    assert observed == [0.1, 5.0]


@pytest.mark.parametrize(
    ("exit_after_terminate", "expected_stop", "expected_signals"),
    [
        (True, "terminate", [signal.SIGTERM]),
        (False, "kill", [signal.SIGTERM, signal.SIGKILL]),
    ],
)
async def test_shared_cleanup_reports_terminate_or_kill_without_real_waits(
    monkeypatch: pytest.MonkeyPatch,
    exit_after_terminate: bool,
    expected_stop: str,
    expected_signals: list[signal.Signals],
) -> None:
    process = _FakeProcess()
    observed_signals: list[signal.Signals] = []
    observed_graces: list[float] = []
    group_alive = True

    def signal_process(process_value: _FakeProcess, selected: signal.Signals) -> bool:
        nonlocal group_alive
        assert process_value is process
        observed_signals.append(selected)
        if selected == signal.SIGKILL:
            group_alive = False
        return True

    async def reap(process_value: _FakeProcess, *, grace: float) -> None:
        assert process_value is process
        observed_graces.append(grace)
        if len(observed_signals) == 1 and exit_after_terminate:
            process.returncode = -15
        elif observed_signals[-1] == signal.SIGKILL:
            process.returncode = -9

    async def wait_group(_: int, *, grace: float) -> bool:
        observed_graces.append(grace)
        if exit_after_terminate and observed_signals == [signal.SIGTERM]:
            return True
        return not group_alive

    monkeypatch.setattr(codex_preflight, "_signal_process_tree", signal_process)
    monkeypatch.setattr(codex_preflight, "_process_group_alive", lambda _: True)
    monkeypatch.setattr(codex_preflight, "_wait_for_process_group_exit", wait_group)
    monkeypatch.setattr(codex_preflight, "_bounded_reap", reap)
    monkeypatch.setattr(codex_preflight, "_close_process_transport", lambda _: None)

    result = await codex_preflight._cleanup_process_group(  # type: ignore[arg-type]
        process,
        (),
        (),
        grace=TERMINATE_GRACE,
    )

    assert result.leader_stop == expected_stop
    assert observed_signals == expected_signals
    assert observed_graces
    assert set(observed_graces) == {TERMINATE_GRACE}


async def test_shared_cleanup_yields_through_clock_around_transport_close(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[tuple[str, float | None]] = []

    class _RecordingClock:
        async def sleep(self, duration: float) -> None:
            events.append(("sleep", duration))

    process = _FakeProcess()
    process.returncode = 0
    monkeypatch.setattr(codex_preflight, "_CLEANUP_CLOCK", _RecordingClock(), raising=False)
    monkeypatch.setattr(codex_preflight, "_process_group_alive", lambda _: False)
    monkeypatch.setattr(
        codex_preflight,
        "_close_process_transport",
        lambda _: events.append(("close", None)),
    )

    result = await codex_preflight._cleanup_process_group(  # type: ignore[arg-type]
        process,
        (),
        (),
        grace=TERMINATE_GRACE,
    )

    assert result.group_gone is True
    assert events == [("sleep", 0), ("close", None), ("sleep", 0)]


async def test_non_posix_cleanup_terminates_then_kills_a_blocked_live_leader(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = _BlockedUntilKilledProcess()

    async def reap(*args: Any, **kwargs: Any) -> None:
        return None

    monkeypatch.setattr(codex_preflight.os, "name", "nt")
    monkeypatch.setattr(codex_preflight, "_bounded_reap", reap)
    monkeypatch.setattr(codex_preflight, "_close_process_transport", lambda _: None)

    result = await codex_preflight._cleanup_process_group(  # type: ignore[arg-type]
        process,
        (),
        (),
        grace=TERMINATE_GRACE,
    )

    assert process.terminate_calls == 1
    assert process.kill_calls == 1
    assert result == codex_preflight.ProcessGroupCleanupResult(
        leader_stop="kill",
        group_stop="kill",
        leader_exited=True,
        group_gone=True,
    )


async def test_non_posix_cleanup_finishes_before_cancellation_reraises(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    process = _BlockedUntilKilledProcess()
    transport = _transport(workspace, _ProcessFactory(process))
    reap_started = asyncio.Event()
    release_reap = asyncio.Event()

    async def reap(process_value: _BlockedUntilKilledProcess, *, grace: float) -> None:
        assert process_value is process
        assert grace == TERMINATE_GRACE
        if process.returncode is None:
            reap_started.set()
            await release_reap.wait()

    monkeypatch.setattr(codex_preflight.os, "name", "nt")
    monkeypatch.setattr(codex_preflight, "_bounded_reap", reap)
    monkeypatch.setattr(codex_preflight, "_close_process_transport", lambda _: None)
    cleanup = asyncio.create_task(
        transport._clean_started_process(  # type: ignore[arg-type]
            process,
            (),
            (),
            deadline=CodexRunDeadline(540.0, VirtualClock()),
        )
    )
    await reap_started.wait()
    cleanup.cancel()
    release_reap.set()

    with pytest.raises(asyncio.CancelledError):
        await cleanup
    assert process.terminate_calls == 1
    assert process.kill_calls == 1
    assert process.returncode == -9


async def test_residual_group_is_killed_after_leader_already_exited(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = _FakeProcess()
    process.returncode = 0
    signals: list[signal.Signals] = []
    group_alive = True

    def alive(_: int) -> bool:
        return group_alive

    def signal_group(process_value: _FakeProcess, selected: signal.Signals) -> bool:
        nonlocal group_alive
        assert process_value is process
        signals.append(selected)
        if selected == signal.SIGKILL:
            group_alive = False
        return True

    async def reap(*args: Any, **kwargs: Any) -> None:
        return None

    async def wait_group(_: int, *, grace: float) -> bool:
        return not group_alive

    monkeypatch.setattr(codex_preflight, "_process_group_alive", alive, raising=False)
    monkeypatch.setattr(codex_preflight, "_wait_for_process_group_exit", wait_group)
    monkeypatch.setattr(codex_preflight, "_signal_process_tree", signal_group)
    monkeypatch.setattr(codex_preflight, "_bounded_reap", reap)
    monkeypatch.setattr(codex_preflight, "_close_process_transport", lambda _: None)

    result = await codex_preflight._cleanup_process_group(  # type: ignore[arg-type]
        process,
        (),
        (),
        grace=TERMINATE_GRACE,
    )

    assert result.leader_stop == "none"
    assert result.group_stop == "kill"
    assert result.group_gone is True
    assert signals == [signal.SIGTERM, signal.SIGKILL]


@pytest.mark.skipif(os.name != "posix", reason="requires POSIX process groups")
@pytest.mark.real_time
async def test_real_residual_child_is_stopped_after_parent_exits(
    tmp_path: Path,
) -> None:
    child_pid_file = tmp_path / "child.pid"
    script = (
        "import subprocess,sys\n"
        "from pathlib import Path\n"
        "child=subprocess.Popen("
        "[sys.executable,'-c','import time; time.sleep(30)'],"
        "stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n"
        "Path(sys.argv[1]).write_text(str(child.pid))\n"
    )
    parent = await asyncio.create_subprocess_exec(
        sys.executable,
        "-I",
        "-c",
        script,
        str(child_pid_file),
        start_new_session=True,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    assert parent.stdout is not None
    assert parent.stderr is not None
    try:
        async with asyncio.timeout(1.0):
            assert await parent.wait() == 0
            assert child_pid_file.read_text().isdigit()
            result = await codex_preflight._cleanup_process_group(
                parent,
                (),
                (parent.stdout, parent.stderr),
                grace=0.2,
            )
        assert result.leader_stop == "none"
        assert result.group_stop in {"terminate", "kill"}
        assert result.group_gone is True
    finally:
        if codex_preflight._process_group_alive(parent.pid):
            with suppress(ProcessLookupError):
                os.killpg(parent.pid, signal.SIGKILL)
