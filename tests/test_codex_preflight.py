from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
from collections import deque
from collections.abc import Iterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator, Literal, Mapping

import pytest

import nova_audio_agent.executors.codex_preflight as codex_preflight
from nova_audio_agent.executors.codex_preflight import (
    CODEX_PERMISSION_PROFILE_TOML,
    CODEX_ROOT_OVERRIDES,
    CODEX_SHELL_ENV_OVERRIDES,
    AsyncioPreflightRunner,
    CodexPreflight,
    CodexPreflightFailure,
    PreflightCommandResult,
)


@dataclass(frozen=True)
class _Call:
    argv: tuple[str, ...]
    cwd: Path
    env: Mapping[str, str]
    timeout: float
    stdout_limit: int
    stderr_limit: int
    stderr_mode: Literal["discard", "merge"]


class _FakeRunner:
    def __init__(self, *responses: PreflightCommandResult | BaseException) -> None:
        self.responses = deque(responses)
        self.calls: list[_Call] = []

    async def run(
        self,
        argv: tuple[str, ...],
        *,
        cwd: Path,
        env: Mapping[str, str],
        timeout: float,
        stdout_limit: int,
        stderr_limit: int,
        stderr_mode: Literal["discard", "merge"] = "discard",
    ) -> PreflightCommandResult:
        self.calls.append(
            _Call(
                argv=argv,
                cwd=cwd,
                env=dict(env),
                timeout=timeout,
                stdout_limit=stdout_limit,
                stderr_limit=stderr_limit,
                stderr_mode=stderr_mode,
            )
        )
        response = self.responses.popleft()
        if isinstance(response, BaseException):
            raise response
        return response


def _result(stdout: str, *, returncode: int = 0) -> PreflightCommandResult:
    return PreflightCommandResult(returncode=returncode, stdout=stdout.encode())


def _probe_result(
    *,
    cwd_matches: bool = True,
    inside_write: bool = True,
    inside_remove: bool = True,
    outside_write_denied: bool = True,
    child_outside_write_denied: bool = True,
    network_denied: bool = True,
    limits: Mapping[str, str] | None = None,
) -> PreflightCommandResult:
    return _result(
        json.dumps(
            {
                "cwd_matches": cwd_matches,
                "inside_write": inside_write,
                "inside_remove": inside_remove,
                "outside_write_denied": outside_write_denied,
                "child_outside_write_denied": child_outside_write_denied,
                "network_denied": network_denied,
                "limits": (
                    {"cpu": "finite", "as": "unbounded", "nofile": "unavailable"}
                    if limits is None
                    else limits
                ),
            }
        )
    )


@asynccontextmanager
async def _fake_probe(_: Path) -> AsyncIterator[tuple[str, ...]]:
    yield ("python3", "-I", "-c", "PROBE_SENTINEL")


def _successful_runner(workspace: Path) -> _FakeRunner:
    return _FakeRunner(
        _result("codex-cli 0.145.0\n"),
        _result("Logged in using ChatGPT\n"),
        _result(f"{workspace}\n"),
        _probe_result(),
    )


@pytest.mark.asyncio
async def test_preflight_constructs_exact_commands_and_stderr_modes(
    tmp_path: Path,
) -> None:
    workspace = tmp_path.resolve()
    runner = _successful_runner(workspace)
    preflight = CodexPreflight(
        binary="/opt/homebrew/bin/codex",
        workspace=workspace,
        runner=runner,
        environ={
            "PATH": "/safe/bin",
            "HOME": "/private/home",
            "LANG": "en_US.UTF-8",
            "NOVA_AUDIO_AGENT_HA_TOKEN": "must-not-pass",
        },
        probe_factory=_fake_probe,
    )

    await preflight.run()

    assert runner.calls[0].argv == ("/opt/homebrew/bin/codex", "--version")
    assert runner.calls[1].argv == (
        "/opt/homebrew/bin/codex",
        "login",
        "status",
    )
    assert runner.calls[2].argv == (
        "git",
        "-C",
        str(workspace),
        "rev-parse",
        "--show-toplevel",
    )
    assert runner.calls[3].argv == (
        "/opt/homebrew/bin/codex",
        "sandbox",
        "-P",
        "nova_audio_agent",
        "-C",
        str(workspace),
        "-c",
        f"permissions.nova_audio_agent={CODEX_PERMISSION_PROFILE_TOML}",
        *CODEX_SHELL_ENV_OVERRIDES,
        "python3",
        "-I",
        "-c",
        "PROBE_SENTINEL",
    )
    assert [call.stderr_mode for call in runner.calls] == [
        "discard",
        "merge",
        "discard",
        "discard",
    ]


@pytest.mark.asyncio
async def test_preflight_command_uses_fixed_profile_and_safe_environment(
    tmp_path: Path,
) -> None:
    workspace = tmp_path.resolve()
    runner = _successful_runner(workspace)
    preflight = CodexPreflight(
        binary="codex",
        workspace=workspace,
        runner=runner,
        environ={
            "PATH": "/safe/bin",
            "HOME": "/private/home",
            "CODEX_HOME": "/private/codex",
            "LC_ALL": "C.UTF-8",
            "SSL_CERT_FILE": "/safe/ca.pem",
            "OPENAI_API_KEY": "must-not-pass",
            "NOVA_AUDIO_AGENT_HA_TOKEN": "must-not-pass",
            "TAVILY_API_KEY": "must-not-pass",
        },
        probe_factory=_fake_probe,
    )

    await preflight.run()

    expected_profile = (
        '{ filesystem = { ":root" = "read", ":workspace_roots" = { "." = "write", '
        '".git" = "read", ".agents" = "read", ".codex" = "read" } }, '
        "network = { enabled = false } }"
    )
    assert CODEX_PERMISSION_PROFILE_TOML == expected_profile
    assert CODEX_ROOT_OVERRIDES == (
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
        f"permissions.nova_audio_agent={expected_profile}",
        *CODEX_SHELL_ENV_OVERRIDES,
    )
    assert all(
        call.env
        == {
            "PATH": "/safe/bin",
            "HOME": "/private/home",
            "CODEX_HOME": "/private/codex",
            "LC_ALL": "C.UTF-8",
            "SSL_CERT_FILE": "/safe/ca.pem",
        }
        for call in runner.calls
    )


@pytest.mark.asyncio
async def test_preflight_command_contains_no_expanding_or_work_order_arguments(
    tmp_path: Path,
) -> None:
    work_order = "WORK_ORDER_MUST_NOT_APPEAR"
    workspace = tmp_path.resolve()
    runner = _successful_runner(workspace)

    await CodexPreflight(
        binary="codex",
        workspace=workspace,
        runner=runner,
        environ={"PATH": "/safe/bin"},
        probe_factory=_fake_probe,
    ).run()

    all_arguments = [argument for call in runner.calls for argument in call.argv]
    assert work_order not in all_arguments
    assert "-s" not in all_arguments
    assert ":workspace" not in all_arguments
    assert "--add-dir" not in all_arguments
    assert "--search" not in all_arguments
    assert "--dangerously-bypass-approvals-and-sandbox" not in all_arguments
    assert "danger-full-access" not in all_arguments


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("raw_version", "expected"),
    [
        ("codex-cli 0.145.0\n", "0.145.0"),
        ("codex-cli 0.145.1\n", "0.145.1"),
        ("codex-cli 1.0.0\n", "1.0.0"),
    ],
)
async def test_supported_codex_version_is_reduced_to_numeric_evidence(
    tmp_path: Path, raw_version: str, expected: str
) -> None:
    runner = _successful_runner(tmp_path)
    runner.responses[0] = _result(raw_version)

    report = await CodexPreflight(
        binary="codex",
        workspace=tmp_path,
        runner=runner,
        environ={"PATH": "/safe/bin"},
        probe_factory=_fake_probe,
    ).run()

    assert report.version == expected
    assert raw_version.strip() not in repr(report)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "raw_version",
    [
        "codex-cli 0.144.99\n",
        "codex-cli 0.145\n",
        "codex 0.145.0\n",
        "codex-cli 0.145.0-alpha\n",
        "malformed-version-sentinel\n",
    ],
)
async def test_unsupported_or_ambiguous_version_is_refused_without_raw_output(
    tmp_path: Path, raw_version: str
) -> None:
    runner = _FakeRunner(_result(raw_version))

    with pytest.raises(CodexPreflightFailure) as exc_info:
        await CodexPreflight(
            binary="codex",
            workspace=tmp_path,
            runner=runner,
            environ={"PATH": "/safe/bin"},
            probe_factory=_fake_probe,
        ).run()

    assert exc_info.value.code == "unsupported_version"
    assert str(exc_info.value) == "unsupported_version"
    assert raw_version.strip() not in repr(exc_info.value)


@pytest.mark.asyncio
async def test_configured_api_key_skips_login_and_is_process_only(
    tmp_path: Path,
) -> None:
    token = "not-a-real-configured-token"
    runner = _FakeRunner(
        _result("codex-cli 0.145.0\n"),
        _result(f"{tmp_path}\n"),
        _probe_result(),
    )

    report = await CodexPreflight(
        binary="codex",
        workspace=tmp_path,
        api_key=token,
        runner=runner,
        environ={"PATH": "/safe/bin", "OPENAI_API_KEY": "parent-secret"},
        probe_factory=_fake_probe,
    ).run()

    assert [call.argv for call in runner.calls] == [
        ("codex", "--version"),
        ("git", "-C", str(tmp_path), "rev-parse", "--show-toplevel"),
        runner.calls[2].argv,
    ]
    assert all(call.env["CODEX_API_KEY"] == token for call in runner.calls)
    assert all("OPENAI_API_KEY" not in call.env for call in runner.calls)
    assert report.credential_present is True
    assert report.credential_identity == "api_key"
    assert report.credential_policy == "process_only"
    assert token not in repr(report)
    assert token not in repr(report.to_mapping())


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("login_status", "identity"),
    [
        ("Logged in using ChatGPT\n", "chatgpt"),
        ("Logged in using API key\n", "api_key"),
    ],
)
async def test_saved_login_retains_only_identity_enum(
    tmp_path: Path, login_status: str, identity: str
) -> None:
    runner = _successful_runner(tmp_path)
    runner.responses[1] = _result(login_status)

    report = await CodexPreflight(
        binary="codex",
        workspace=tmp_path,
        runner=runner,
        environ={"PATH": "/safe/bin"},
        probe_factory=_fake_probe,
    ).run()

    assert report.credential_identity == identity
    assert report.credential_policy == "saved_login"
    assert login_status.strip() not in repr(report)


@pytest.mark.asyncio
async def test_login_status_lines_allow_warnings_and_one_exact_identity(
    tmp_path: Path,
) -> None:
    warning = "WARNING: path-alias setup failed: warning-detail-sentinel"
    raw_status = f"{warning}\nanother harmless warning line\nLogged in using ChatGPT\n"
    runner = _successful_runner(tmp_path)
    runner.responses[1] = _result(raw_status)

    report = await CodexPreflight(
        binary="codex",
        workspace=tmp_path,
        runner=runner,
        environ={"PATH": "/safe/bin"},
        probe_factory=_fake_probe,
    ).run()

    assert report.credential_identity == "chatgpt"
    assert warning not in repr(report)
    assert raw_status not in repr(report)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "raw_status",
    [
        "WARNING: no identity line\n",
        "Logged in using ChatGPT\nLogged in using ChatGPT\n",
        "Logged in using ChatGPT\nLogged in using API key\n",
        "Not logged in using ChatGPT\nLogged in using ChatGPT\n",
        "prefix Logged in using ChatGPT suffix\n",
        "Logged in using ChatGPT suffix\n",
    ],
)
async def test_login_status_lines_require_exactly_one_unambiguous_identity(
    tmp_path: Path,
    raw_status: str,
) -> None:
    runner = _FakeRunner(
        _result("codex-cli 0.145.0\n"),
        _result(raw_status),
    )

    with pytest.raises(CodexPreflightFailure) as exc_info:
        await CodexPreflight(
            binary="codex",
            workspace=tmp_path,
            runner=runner,
            environ={"PATH": "/safe/bin"},
            probe_factory=_fake_probe,
        ).run()

    assert exc_info.value.code == "credential_missing"
    assert raw_status.strip() not in repr(exc_info.value)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "login_status",
    [
        "Not logged in\n",
        "Logged in using ChatGPT and API key\n",
        "ambiguous-auth-output-sentinel\n",
    ],
)
async def test_missing_or_ambiguous_saved_login_is_refused(
    tmp_path: Path, login_status: str
) -> None:
    runner = _FakeRunner(
        _result("codex-cli 0.145.0\n"),
        _result(login_status),
    )

    with pytest.raises(CodexPreflightFailure) as exc_info:
        await CodexPreflight(
            binary="codex",
            workspace=tmp_path,
            runner=runner,
            environ={"PATH": "/safe/bin"},
            probe_factory=_fake_probe,
        ).run()

    assert exc_info.value.code == "credential_missing"
    assert login_status.strip() not in repr(exc_info.value)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "login_status",
    [
        "Not logged in using ChatGPT\n",
        "warning: Logged in using ChatGPT\n",
        "Logged in using ChatGPT (stale)\n",
        "prefix Logged in using API key suffix\n",
    ],
)
async def test_login_rejects_negation_or_text_around_known_success(
    tmp_path: Path, login_status: str
) -> None:
    runner = _FakeRunner(
        _result("codex-cli 0.145.0\n"),
        _result(login_status),
    )

    with pytest.raises(CodexPreflightFailure) as exc_info:
        await CodexPreflight(
            binary="codex",
            workspace=tmp_path,
            runner=runner,
            environ={"PATH": "/safe/bin"},
            probe_factory=_fake_probe,
        ).run()

    assert exc_info.value.code == "credential_missing"
    assert login_status.strip() not in repr(exc_info.value)


@pytest.mark.asyncio
async def test_git_root_must_resolve_to_exact_configured_workspace(
    tmp_path: Path,
) -> None:
    other = tmp_path / "other"
    other.mkdir()
    runner = _FakeRunner(
        _result("codex-cli 0.145.0\n"),
        _result("Logged in using ChatGPT\n"),
        _result(f"{other}\n"),
    )

    with pytest.raises(CodexPreflightFailure) as exc_info:
        await CodexPreflight(
            binary="codex",
            workspace=tmp_path,
            runner=runner,
            environ={"PATH": "/safe/bin"},
            probe_factory=_fake_probe,
        ).run()

    assert exc_info.value.code == "workspace_root_mismatch"
    assert str(tmp_path) not in repr(exc_info.value)
    assert str(other) not in repr(exc_info.value)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failed_evidence",
    [
        "cwd_matches",
        "inside_write",
        "inside_remove",
        "outside_write_denied",
        "child_outside_write_denied",
        "network_denied",
    ],
)
async def test_any_failed_empirical_sandbox_evidence_refuses_work(
    tmp_path: Path, failed_evidence: str
) -> None:
    evidence = {
        "cwd_matches": True,
        "inside_write": True,
        "inside_remove": True,
        "outside_write_denied": True,
        "child_outside_write_denied": True,
        "network_denied": True,
    }
    evidence[failed_evidence] = False
    runner = _FakeRunner(
        _result("codex-cli 0.145.0\n"),
        _result("Logged in using ChatGPT\n"),
        _result(f"{tmp_path}\n"),
        _probe_result(**evidence),
    )

    with pytest.raises(CodexPreflightFailure) as exc_info:
        await CodexPreflight(
            binary="codex",
            workspace=tmp_path,
            runner=runner,
            environ={"PATH": "/safe/bin"},
            probe_factory=_fake_probe,
        ).run()

    assert exc_info.value.code == "sandbox_failed"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "limits",
    [
        {"cpu": "finite", "as": "finite", "nofile": "finite"},
        {"cpu": "unbounded", "as": "unbounded", "nofile": "unbounded"},
        {"cpu": "unavailable", "as": "unavailable", "nofile": "unavailable"},
        {"cpu": "finite", "as": "unbounded", "nofile": "unavailable"},
    ],
)
async def test_resource_limits_retain_only_fixed_classifications(
    tmp_path: Path, limits: Mapping[str, str]
) -> None:
    runner = _FakeRunner(
        _result("codex-cli 0.145.0\n"),
        _result("Logged in using ChatGPT\n"),
        _result(f"{tmp_path}\n"),
        _probe_result(limits=limits),
    )

    report = await CodexPreflight(
        binary="codex",
        workspace=tmp_path,
        runner=runner,
        environ={"PATH": "/safe/bin"},
        probe_factory=_fake_probe,
    ).run()

    assert dict(report.limits) == limits
    with pytest.raises(TypeError):
        report.limits["cpu"] = "unbounded"  # type: ignore[index]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "probe_result",
    [
        _result("not-json-probe-command-sentinel"),
        _result(
            '{"cwd_matches":true,"inside_write":true,"inside_remove":true,'
            '"outside_write_denied":false,"outside_write_denied":true,'
            '"child_outside_write_denied":true,"network_denied":true,'
            '"limits":{"cpu":"finite","as":"finite","nofile":"finite"}}'
        ),
        _probe_result(limits={"cpu": "unknown", "as": "finite", "nofile": "finite"}),
        _probe_result(limits={"cpu": "finite", "as": "finite"}),
        _result("{}", returncode=1),
    ],
)
async def test_malformed_unusable_or_duplicated_probe_is_refused(
    tmp_path: Path, probe_result: PreflightCommandResult
) -> None:
    runner = _FakeRunner(
        _result("codex-cli 0.145.0\n"),
        _result("Logged in using ChatGPT\n"),
        _result(f"{tmp_path}\n"),
        probe_result,
    )

    with pytest.raises(CodexPreflightFailure) as exc_info:
        await CodexPreflight(
            binary="codex",
            workspace=tmp_path,
            runner=runner,
            environ={"PATH": "/safe/bin"},
            probe_factory=_fake_probe,
        ).run()

    assert exc_info.value.code == "sandbox_failed"
    assert "probe-command-sentinel" not in repr(exc_info.value)


@pytest.mark.asyncio
async def test_report_mapping_matches_adapter_contract_without_sensitive_fields(
    tmp_path: Path,
) -> None:
    runner = _successful_runner(tmp_path)

    report = await CodexPreflight(
        binary="codex",
        workspace=tmp_path,
        runner=runner,
        environ={"PATH": "/safe/bin", "HOME": "/secret/home"},
        probe_factory=_fake_probe,
    ).run()

    assert report.to_mapping() == {
        "version": "0.145.0",
        "root_matches": True,
        "mount": "workspace_only",
        "subprocess": "contained",
        "network": "blocked",
        "credential": {
            "present": True,
            "identity": "chatgpt",
            "policy": "saved_login",
        },
        "limits": {
            "cpu": "finite",
            "as": "unbounded",
            "nofile": "unavailable",
        },
    }
    retained = repr(report) + repr(report.to_mapping())
    assert "/secret/home" not in retained
    assert str(tmp_path) not in retained
    assert "PROBE_SENTINEL" not in retained


@pytest.mark.asyncio
async def test_runner_exception_and_raw_stderr_are_reduced_to_literal_code(
    tmp_path: Path,
) -> None:
    raw_stderr = "raw-stderr-secret-sentinel"
    runner = _FakeRunner(RuntimeError(raw_stderr))

    with pytest.raises(CodexPreflightFailure) as exc_info:
        await CodexPreflight(
            binary="codex",
            workspace=tmp_path,
            runner=runner,
            environ={"PATH": "/safe/bin"},
            probe_factory=_fake_probe,
        ).run()

    assert exc_info.value.code == "preflight_failed"
    assert raw_stderr not in str(exc_info.value)
    assert raw_stderr not in repr(exc_info.value)
    assert exc_info.value.__cause__ is None


@pytest.mark.asyncio
async def test_timeout_is_reduced_to_literal_code(tmp_path: Path) -> None:
    runner = _FakeRunner(TimeoutError("timeout-detail-sentinel"))

    with pytest.raises(CodexPreflightFailure) as exc_info:
        await CodexPreflight(
            binary="codex",
            workspace=tmp_path,
            runner=runner,
            environ={"PATH": "/safe/bin"},
            probe_factory=_fake_probe,
        ).run()

    assert exc_info.value.code == "preflight_timeout"
    assert "timeout-detail-sentinel" not in repr(exc_info.value)
    assert runner.calls[0].timeout <= 20.0


def _descendant_command(
    pid_file: Path,
    heartbeat_file: Path,
    *,
    overflow: bool,
    overflow_stream: Literal["stdout", "stderr"] = "stdout",
    overflow_bytes: int = 4096,
) -> tuple[str, ...]:
    child_script = (
        "import os, pathlib, sys, time\n"
        "pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\n"
        "time.sleep(0.05)\n"
        "pathlib.Path(sys.argv[2]).write_text('descendant-survived')\n"
        "time.sleep(30)\n"
    )
    parent_script = (
        "import pathlib, subprocess, sys, time\n"
        "pid_file, heartbeat_file, child_script = sys.argv[1:]\n"
        "subprocess.Popen([sys.executable, '-u', '-c', child_script, "
        "pid_file, heartbeat_file])\n"
        "deadline = time.monotonic() + 2\n"
        "while not pathlib.Path(pid_file).exists():\n"
        "  if time.monotonic() >= deadline: raise SystemExit(7)\n"
        "  time.sleep(0.01)\n"
        + (
            f"sys.{overflow_stream}.buffer.write(b'x' * {overflow_bytes})\n"
            f"sys.{overflow_stream}.buffer.flush()\n"
            if overflow
            else ""
        )
        + "time.sleep(30)\n"
    )
    return (
        sys.executable,
        "-u",
        "-c",
        parent_script,
        str(pid_file),
        str(heartbeat_file),
        child_script,
    )


def _process_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def _cleanup_test_process(pid_file: Path) -> None:
    if not pid_file.exists():
        return
    pid = int(pid_file.read_text())
    if _process_exists(pid):
        os.kill(pid, signal.SIGKILL)


@pytest.mark.asyncio
@pytest.mark.real_time
async def test_runner_merged_stderr_is_returned_through_stdout_bound(
    tmp_path: Path,
) -> None:
    runner = AsyncioPreflightRunner()
    expected = b"warning-line\nLogged in using ChatGPT\n"

    result = await runner.run(
        (
            sys.executable,
            "-c",
            "import sys; sys.stderr.buffer.write(" + repr(expected) + ")",
        ),
        cwd=tmp_path,
        env={"PATH": os.environ["PATH"]},
        timeout=0.5,
        stdout_limit=len(expected),
        stderr_limit=8,
        stderr_mode="merge",
    )

    assert result.returncode == 0
    assert result.stdout == expected


@pytest.mark.asyncio
@pytest.mark.real_time
async def test_runner_bounds_stdout_overflow_with_descendant_holding_pipes(
    tmp_path: Path,
) -> None:
    pid_file = tmp_path / "descendant.pid"
    heartbeat = tmp_path / "descendant-heartbeat"
    runner = AsyncioPreflightRunner()

    try:
        with pytest.raises(CodexPreflightFailure) as exc_info:
            await asyncio.wait_for(
                runner.run(
                    _descendant_command(pid_file, heartbeat, overflow=True),
                    cwd=tmp_path,
                    env={"PATH": os.environ["PATH"]},
                    timeout=0.75,
                    stdout_limit=32,
                    stderr_limit=32,
                ),
                timeout=2.0,
            )
        await asyncio.sleep(0.08)
    finally:
        _cleanup_test_process(pid_file)

    assert exc_info.value.code == "preflight_failed"
    assert not heartbeat.exists()


@pytest.mark.asyncio
@pytest.mark.real_time
@pytest.mark.parametrize(
    ("overflow_stream", "stderr_mode"),
    [
        ("stdout", "discard"),
        ("stderr", "discard"),
        ("stderr", "merge"),
    ],
)
async def test_large_stream_transport_is_closed_after_bounded_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    overflow_stream: Literal["stdout", "stderr"],
    stderr_mode: Literal["discard", "merge"],
) -> None:
    pid_file = tmp_path / f"{overflow_stream}-{stderr_mode}-descendant.pid"
    heartbeat = tmp_path / f"{overflow_stream}-{stderr_mode}-heartbeat"
    loop = asyncio.get_running_loop()
    original_debug = loop.get_debug()
    original_handler = loop.get_exception_handler()
    loop_errors: list[dict[str, object]] = []
    processes: list[asyncio.subprocess.Process] = []
    create_subprocess = asyncio.create_subprocess_exec

    async def capture_process(*argv: str, **kwargs: object) -> asyncio.subprocess.Process:
        process = await create_subprocess(*argv, **kwargs)
        processes.append(process)
        return process

    loop.set_debug(True)
    loop.set_exception_handler(lambda _loop, context: loop_errors.append(context))
    monkeypatch.setattr(asyncio, "create_subprocess_exec", capture_process)

    try:
        with pytest.raises(CodexPreflightFailure) as exc_info:
            await asyncio.wait_for(
                AsyncioPreflightRunner().run(
                    _descendant_command(
                        pid_file,
                        heartbeat,
                        overflow=True,
                        overflow_stream=overflow_stream,
                        overflow_bytes=1024 * 1024,
                    ),
                    cwd=tmp_path,
                    env={"PATH": os.environ["PATH"]},
                    timeout=0.75,
                    stdout_limit=32,
                    stderr_limit=32,
                    stderr_mode=stderr_mode,
                ),
                timeout=2.0,
            )
        await asyncio.sleep(0.08)

        assert exc_info.value.code == "preflight_failed"
        assert len(processes) == 1
        process = processes[0]
        assert process.returncode is not None
        transport = process._transport  # type: ignore[attr-defined]
        assert transport.is_closing()
        for descriptor in (1, 2):
            pipe = transport.get_pipe_transport(descriptor)
            assert pipe is None or pipe.is_closing()
        assert loop_errors == []
        assert not heartbeat.exists()
    finally:
        loop.set_exception_handler(original_handler)
        loop.set_debug(original_debug)
        _cleanup_test_process(pid_file)


@pytest.mark.asyncio
@pytest.mark.real_time
async def test_runner_bounds_merged_stderr_and_kills_pipe_holding_descendant(
    tmp_path: Path,
) -> None:
    pid_file = tmp_path / "stderr-descendant.pid"
    heartbeat = tmp_path / "stderr-descendant-heartbeat"
    runner = AsyncioPreflightRunner()

    try:
        with pytest.raises(CodexPreflightFailure) as exc_info:
            await asyncio.wait_for(
                runner.run(
                    _descendant_command(
                        pid_file,
                        heartbeat,
                        overflow=True,
                        overflow_stream="stderr",
                    ),
                    cwd=tmp_path,
                    env={"PATH": os.environ["PATH"]},
                    timeout=0.75,
                    stdout_limit=32,
                    stderr_limit=8,
                    stderr_mode="merge",
                ),
                timeout=2.0,
            )
        await asyncio.sleep(0.08)
    finally:
        _cleanup_test_process(pid_file)

    assert exc_info.value.code == "preflight_failed"
    assert not heartbeat.exists()


@pytest.mark.asyncio
@pytest.mark.real_time
async def test_runner_cancellation_kills_descendants_and_reraises_cancel(
    tmp_path: Path,
) -> None:
    pid_file = tmp_path / "cancel-descendant.pid"
    heartbeat = tmp_path / "cancel-descendant-heartbeat"
    runner = AsyncioPreflightRunner()
    task = asyncio.create_task(
        runner.run(
            _descendant_command(pid_file, heartbeat, overflow=False),
            cwd=tmp_path,
            env={"PATH": os.environ["PATH"]},
            timeout=5.0,
            stdout_limit=32,
            stderr_limit=32,
        )
    )

    try:
        async with asyncio.timeout(1.0):
            while not pid_file.exists():
                await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=0.5)
        await asyncio.sleep(0.08)
    finally:
        if not task.done():
            task.cancel()
        _cleanup_test_process(pid_file)

    assert task.cancelled()
    assert not heartbeat.exists()


class _StringSubclass(str):
    pass


class _HostileMapping(Mapping[str, str]):
    def __getitem__(self, key: str) -> str:
        raise KeyError(key)

    def __iter__(self) -> Iterator[str]:
        return iter(())

    def __len__(self) -> int:
        return 0

    def items(self) -> object:
        raise RuntimeError("hostile-environ-detail-sentinel")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "overrides",
    [
        {"binary": _StringSubclass("binary-subclass-sentinel")},
        {"api_key": _StringSubclass("api-key-subclass-sentinel")},
        {"environ": _HostileMapping()},
        {"environ": {_StringSubclass("env-key-subclass-sentinel"): "/safe/bin"}},
        {"environ": {"PATH": _StringSubclass("env-value-subclass-sentinel")}},
    ],
)
async def test_hostile_configuration_is_reduced_before_command_construction(
    tmp_path: Path, overrides: Mapping[str, object]
) -> None:
    runner = _successful_runner(tmp_path)
    arguments = {
        "binary": "codex",
        "workspace": tmp_path,
        "api_key": None,
        "runner": runner,
        "environ": {"PATH": "/safe/bin"},
        "probe_factory": _fake_probe,
        **overrides,
    }

    with pytest.raises(CodexPreflightFailure) as exc_info:
        await CodexPreflight(**arguments).run()  # type: ignore[arg-type]

    assert exc_info.value.code == "preflight_failed"
    retained = repr(exc_info.value)
    for sentinel in (
        "binary-subclass-sentinel",
        "api-key-subclass-sentinel",
        "hostile-environ-detail-sentinel",
        "env-key-subclass-sentinel",
        "env-value-subclass-sentinel",
    ):
        assert sentinel not in retained
    assert runner.calls == []


@pytest.mark.asyncio
async def test_preflight_runs_fresh_probe_for_every_work_order(tmp_path: Path) -> None:
    runner = _FakeRunner(
        *(
            (
                _result("codex-cli 0.145.0\n"),
                _result("Logged in using ChatGPT\n"),
                _result(f"{tmp_path}\n"),
                _probe_result(),
            )
            * 2
        )
    )
    probe_calls = 0

    @asynccontextmanager
    async def counting_probe(_: Path) -> AsyncIterator[tuple[str, ...]]:
        nonlocal probe_calls
        probe_calls += 1
        yield ("python3", "-I", "-c", "PROBE_SENTINEL")

    preflight = CodexPreflight(
        binary="codex",
        workspace=tmp_path,
        runner=runner,
        environ={"PATH": "/safe/bin"},
        probe_factory=counting_probe,
    )

    await preflight.run()
    await preflight.run()

    assert probe_calls == 2
    assert len(runner.calls) == 8


@pytest.mark.asyncio
async def test_default_preflight_uses_empirical_probe_factory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner = _successful_runner(tmp_path)
    monkeypatch.setattr(codex_preflight, "_empirical_probe", _fake_probe)

    report = await CodexPreflight(
        binary="codex",
        workspace=tmp_path,
        runner=runner,
        environ={"PATH": "/safe/bin"},
    ).run()

    assert report.mount == "workspace_only"
    assert report.subprocess == "contained"
    assert report.network == "blocked"


@pytest.mark.asyncio
async def test_empirical_probe_cleans_sibling_after_setup_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sibling = tmp_path.parent / f"{tmp_path.name}-probe-sibling"
    original_write_bytes = Path.write_bytes

    def make_sibling(*_: object, **__: object) -> str:
        sibling.mkdir()
        return str(sibling)

    def fail_canary(self: Path, value: bytes) -> int:
        if self == sibling / "canary":
            raise OSError("setup-detail-must-not-escape")
        return original_write_bytes(self, value)

    monkeypatch.setattr(codex_preflight.tempfile, "mkdtemp", make_sibling)
    monkeypatch.setattr(Path, "write_bytes", fail_canary)
    runner = _FakeRunner(
        _result("codex-cli 0.145.0\n"),
        _result("Logged in using ChatGPT\n"),
        _result(f"{tmp_path}\n"),
    )

    with pytest.raises(CodexPreflightFailure) as exc_info:
        await CodexPreflight(
            binary="codex",
            workspace=tmp_path,
            runner=runner,
            environ={"PATH": "/safe/bin"},
        ).run()

    assert exc_info.value.code == "preflight_failed"
    assert "setup-detail-must-not-escape" not in repr(exc_info.value)
    assert not sibling.exists()


class _FakeSocket:
    def getsockname(self) -> tuple[str, int]:
        return ("127.0.0.1", 43123)


class _FakeServer:
    sockets = (_FakeSocket(),)

    def close(self) -> None:
        pass

    async def wait_closed(self) -> None:
        pass


@pytest.mark.asyncio
@pytest.mark.parametrize("mutation", ["content", "replace", "metadata"])
async def test_empirical_probe_rejects_host_canary_mutation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mutation: str,
) -> None:
    async def fake_start_server(*_: object, **__: object) -> _FakeServer:
        return _FakeServer()

    monkeypatch.setattr(asyncio, "start_server", fake_start_server)

    with pytest.raises(CodexPreflightFailure) as exc_info:
        async with codex_preflight._empirical_probe(tmp_path) as probe_argv:
            canary = Path(probe_argv[-3])
            if mutation == "content":
                canary.write_bytes(b"mutated-content")
            elif mutation == "replace":
                replacement = canary.with_name("replacement")
                replacement.write_bytes(b"host-created-canary")
                os.replace(replacement, canary)
            else:
                canary.chmod(0o600)

    assert exc_info.value.code == "sandbox_failed"
