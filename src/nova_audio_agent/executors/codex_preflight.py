"""Deterministic, credential-safe preflight for the Codex worker."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import uuid
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Literal, Protocol

from nova_audio_agent.clock import RealClock
from nova_audio_agent.process_tree import (
    KILL_SIGNAL,
    TERMINATE_SIGNAL,
    signal_tree,
    spawn_supervision_kwargs,
    tree_alive,
)

CODEX_PERMISSION_PROFILE_TOML = (
    '{ filesystem = { ":root" = "read", ":workspace_roots" = { "." = "write", '
    '".git" = "read", ".agents" = "read", ".codex" = "read" } }, '
    "network = { enabled = false } }"
)
CODEX_SHELL_ENV_OVERRIDES = (
    "-c",
    'shell_environment_policy.inherit="core"',
    "-c",
    'shell_environment_policy.include_only=["PATH","LANG","LC_ALL","TERM"]',
)
CODEX_ROOT_OVERRIDES = (
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
    *CODEX_SHELL_ENV_OVERRIDES,
)

_ENV_ALLOWLIST = frozenset(
    {
        "PATH",
        "HOME",
        "CODEX_HOME",
        "LANG",
        "LC_ALL",
        "TERM",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
    }
)
_COMMAND_STDOUT_LIMIT = 4096
_PROBE_STDOUT_LIMIT = 8192
_STDERR_LIMIT = 64 * 1024
_PREFLIGHT_TIMEOUT = 20.0
_PROCESS_CLEANUP_GRACE = 0.1
_MINIMUM_VERSION = (0, 145, 0)
_CANARY_CONTENT = b"host-created-canary"
_CLEANUP_CLOCK = RealClock()
_FAILURE_CODES = frozenset(
    {
        "binary_missing",
        "credential_missing",
        "preflight_failed",
        "preflight_timeout",
        "sandbox_failed",
        "unsupported_version",
        "workspace_root_mismatch",
    }
)
_PROBE_BOOLEAN_FIELDS = frozenset(
    {
        "cwd_matches",
        "inside_write",
        "inside_remove",
        "outside_write_denied",
        "child_outside_write_denied",
        "network_denied",
    }
)
_LIMIT_NAMES = frozenset({"cpu", "as", "nofile"})
_LIMIT_CLASSES = frozenset({"finite", "unbounded", "unavailable"})

_PROBE_SCRIPT = r"""
import json
import os
from pathlib import Path
import resource
import socket
import subprocess
import sys

workspace, canary, marker, port_text = sys.argv[1:]
marker_path = Path(marker)

cwd_matches = os.path.realpath(os.getcwd()) == os.path.realpath(workspace)
inside_write = False
inside_remove = False
try:
    marker_path.write_bytes(b"nova-audio-agent-preflight")
    inside_write = True
finally:
    try:
        marker_path.unlink()
        inside_remove = True
    except OSError:
        pass

try:
    Path(canary).write_bytes(b"outside-write-succeeded")
except OSError:
    outside_write_denied = True
else:
    outside_write_denied = False

child_script = (
    "from pathlib import Path; import sys\n"
    "try:\n"
    " Path(sys.argv[1]).write_bytes(b'child-write-succeeded')\n"
    "except OSError:\n"
    " raise SystemExit(0)\n"
    "raise SystemExit(9)\n"
)
try:
    child = subprocess.run(
        [sys.executable, "-I", "-c", child_script, canary],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        timeout=2,
    )
    child_outside_write_denied = child.returncode == 0
except Exception:
    child_outside_write_denied = False

try:
    connection = socket.create_connection(("127.0.0.1", int(port_text)), timeout=1)
except OSError:
    network_denied = True
else:
    network_denied = False
    connection.close()

def classify(resource_name):
    resource_id = getattr(resource, resource_name, None)
    if resource_id is None:
        return "unavailable"
    try:
        soft, _ = resource.getrlimit(resource_id)
    except (OSError, ValueError):
        return "unavailable"
    if soft == resource.RLIM_INFINITY:
        return "unbounded"
    return "finite"

print(json.dumps({
    "cwd_matches": cwd_matches,
    "inside_write": inside_write,
    "inside_remove": inside_remove,
    "outside_write_denied": outside_write_denied,
    "child_outside_write_denied": child_outside_write_denied,
    "network_denied": network_denied,
    "limits": {
        "cpu": classify("RLIMIT_CPU"),
        "as": classify("RLIMIT_AS"),
        "nofile": classify("RLIMIT_NOFILE"),
    },
}, separators=(",", ":")))
""".strip()


@dataclass(frozen=True, slots=True)
class PreflightCommandResult:
    """Bounded subprocess result with stderr deliberately erased."""

    returncode: int
    stdout: bytes


@dataclass(frozen=True, slots=True)
class ProcessGroupCleanupResult:
    """Verified leader and residual-process-group cleanup evidence."""

    leader_stop: Literal["none", "terminate", "kill"]
    group_stop: Literal["none", "terminate", "kill"]
    leader_exited: bool
    group_gone: bool


class PreflightRunner(Protocol):
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
    ) -> PreflightCommandResult: ...


ProbeFactory = Callable[[Path], AbstractAsyncContextManager[tuple[str, ...], bool | None]]


@dataclass(frozen=True, slots=True)
class CodexPreflightReport:
    version: str
    root_matches: bool
    mount: Literal["workspace_only"]
    subprocess: Literal["contained"]
    network: Literal["blocked"]
    credential_present: bool
    credential_identity: Literal["chatgpt", "api_key", "unknown"]
    credential_policy: Literal["saved_login", "process_only"]
    limits: Mapping[str, str]

    def __post_init__(self) -> None:
        object.__setattr__(self, "limits", MappingProxyType(dict(self.limits)))

    def to_mapping(self) -> dict[str, object]:
        """Return the exact credential-safe envelope accepted by the adapter."""

        return {
            "version": self.version,
            "root_matches": self.root_matches,
            "mount": self.mount,
            "subprocess": self.subprocess,
            "network": self.network,
            "credential": {
                "present": self.credential_present,
                "identity": self.credential_identity,
                "policy": self.credential_policy,
            },
            "limits": dict(self.limits),
        }


class CodexPreflightFailure(RuntimeError):
    """A preflight failure carrying only a system-owned literal code."""

    def __init__(self, code: str) -> None:
        safe_code = code if type(code) is str and code in _FAILURE_CODES else "preflight_failed"
        self.code = safe_code
        super().__init__(safe_code)


class AsyncioPreflightRunner:
    """Run one bounded command without retaining raw stderr."""

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
        if stderr_mode not in {"discard", "merge"}:
            raise CodexPreflightFailure("preflight_failed")
        process = await asyncio.create_subprocess_exec(
            *argv,
            cwd=cwd,
            env=dict(env),
            **spawn_supervision_kwargs(),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=(
                asyncio.subprocess.STDOUT if stderr_mode == "merge" else asyncio.subprocess.PIPE
            ),
        )
        assert process.stdout is not None
        streams = (process.stdout,)
        stdout_task = asyncio.create_task(_read_bounded(process.stdout, stdout_limit, retain=True))
        wait_task = asyncio.create_task(process.wait())
        if stderr_mode == "merge":
            tasks = (stdout_task, wait_task)
        else:
            assert process.stderr is not None
            streams = (process.stdout, process.stderr)
            stderr_task = asyncio.create_task(
                _read_bounded(process.stderr, stderr_limit, retain=False)
            )
            tasks = (stdout_task, stderr_task, wait_task)
        try:
            async with asyncio.timeout(timeout):
                results = await asyncio.gather(*tasks)
        except asyncio.CancelledError:
            await _finish_process_cleanup(
                process,
                tasks,
                streams,
                grace=_PROCESS_CLEANUP_GRACE,
            )
            raise
        except BaseException:
            cancelled, _ = await _finish_process_cleanup(
                process,
                tasks,
                streams,
                grace=_PROCESS_CLEANUP_GRACE,
            )
            if cancelled:
                raise asyncio.CancelledError
            raise
        stdout = results[0]
        returncode = results[-1]
        assert isinstance(stdout, bytes)
        assert isinstance(returncode, int)
        return PreflightCommandResult(returncode, stdout)


class CodexPreflight:
    """Run fresh binary, auth, workspace, and sandbox checks."""

    def __init__(
        self,
        *,
        binary: str,
        workspace: Path,
        api_key: str | None = None,
        runner: PreflightRunner | None = None,
        environ: Mapping[str, str] | None = None,
        probe_factory: ProbeFactory | None = None,
    ) -> None:
        self._binary = binary
        self._workspace = workspace
        self._api_key = api_key
        self._runner = AsyncioPreflightRunner() if runner is None else runner
        self._environ = dict(os.environ) if environ is None else environ
        self._probe_factory = probe_factory

    async def run(self, *, timeout: float = _PREFLIGHT_TIMEOUT) -> CodexPreflightReport:
        timeout = min(_PREFLIGHT_TIMEOUT, timeout)
        if timeout <= 0:
            raise CodexPreflightFailure("preflight_timeout")
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        failure: CodexPreflightFailure | None = None
        try:
            async with asyncio.timeout(timeout):
                _validate_configuration(
                    self._binary,
                    self._api_key,
                    self._environ,
                )
                env = _filtered_environment(self._environ, self._api_key)
                version_result = await self._command(
                    (self._binary, "--version"),
                    env=env,
                    deadline=deadline,
                )
                version = _parse_version(version_result)
                if self._api_key is None:
                    login_result = await self._command(
                        (self._binary, "login", "status"),
                        env=env,
                        deadline=deadline,
                        stderr_mode="merge",
                    )
                    identity = _parse_login(login_result)
                    policy: Literal["saved_login", "process_only"] = "saved_login"
                else:
                    identity = "api_key"
                    policy = "process_only"

                root_result = await self._command(
                    (
                        "git",
                        "-C",
                        str(self._workspace),
                        "rev-parse",
                        "--show-toplevel",
                    ),
                    env=env,
                    deadline=deadline,
                )
                _require_matching_root(root_result, self._workspace)
                probe_factory = (
                    _empirical_probe if self._probe_factory is None else self._probe_factory
                )
                async with probe_factory(self._workspace) as probe_argv:
                    probe_result = await self._command(
                        (
                            self._binary,
                            "sandbox",
                            "-P",
                            "nova_audio_agent",
                            "-C",
                            str(self._workspace),
                            "-c",
                            f"permissions.nova_audio_agent={CODEX_PERMISSION_PROFILE_TOML}",
                            *CODEX_SHELL_ENV_OVERRIDES,
                            *probe_argv,
                        ),
                        env=env,
                        deadline=deadline,
                        stdout_limit=_PROBE_STDOUT_LIMIT,
                    )
                limits = _parse_probe(probe_result)
        except (asyncio.CancelledError, KeyboardInterrupt, SystemExit):
            raise
        except CodexPreflightFailure as exc:
            failure = CodexPreflightFailure(exc.code)
        except TimeoutError:
            failure = CodexPreflightFailure("preflight_timeout")
        except FileNotFoundError:
            failure = CodexPreflightFailure("binary_missing")
        except BaseException:
            failure = CodexPreflightFailure("preflight_failed")

        if failure is not None:
            raise failure

        return CodexPreflightReport(
            version=version,
            root_matches=True,
            mount="workspace_only",
            subprocess="contained",
            network="blocked",
            credential_present=True,
            credential_identity=identity,
            credential_policy=policy,
            limits=limits,
        )

    async def _command(
        self,
        argv: tuple[str, ...],
        *,
        env: Mapping[str, str],
        deadline: float,
        stdout_limit: int = _COMMAND_STDOUT_LIMIT,
        stderr_mode: Literal["discard", "merge"] = "discard",
    ) -> PreflightCommandResult:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise CodexPreflightFailure("preflight_timeout")
        return await self._runner.run(
            argv,
            cwd=self._workspace,
            env=env,
            timeout=remaining,
            stdout_limit=stdout_limit,
            stderr_limit=_STDERR_LIMIT,
            stderr_mode=stderr_mode,
        )


def _filtered_environment(environ: Mapping[str, str], api_key: str | None) -> dict[str, str]:
    result = {name: value for name, value in environ.items() if name in _ENV_ALLOWLIST}
    if api_key is not None:
        result["CODEX_API_KEY"] = api_key
    return result


def _validate_configuration(
    binary: object,
    api_key: object,
    environ: object,
) -> None:
    if type(binary) is not str or not binary:
        raise CodexPreflightFailure("preflight_failed")
    if api_key is not None and (type(api_key) is not str or not api_key):
        raise CodexPreflightFailure("preflight_failed")
    if type(environ) is not dict:
        raise CodexPreflightFailure("preflight_failed")
    if any(type(name) is not str or type(value) is not str for name, value in environ.items()):
        raise CodexPreflightFailure("preflight_failed")


def _decode_stdout(result: PreflightCommandResult, code: str) -> str:
    if (
        type(result) is not PreflightCommandResult
        or type(result.returncode) is not int
        or type(result.stdout) is not bytes
    ):
        raise CodexPreflightFailure(code)
    if result.returncode != 0:
        raise CodexPreflightFailure(code)
    try:
        return result.stdout.decode("utf-8", errors="strict").strip()
    except UnicodeDecodeError:
        raise CodexPreflightFailure(code) from None


def _parse_version(result: PreflightCommandResult) -> str:
    value = _decode_stdout(result, "unsupported_version")
    prefix = "codex-cli "
    if not value.startswith(prefix):
        raise CodexPreflightFailure("unsupported_version")
    version = value.removeprefix(prefix)
    parts = version.split(".")
    if len(parts) != 3 or any(not part.isascii() or not part.isdigit() for part in parts):
        raise CodexPreflightFailure("unsupported_version")
    parsed = tuple(int(part) for part in parts)
    if parsed < _MINIMUM_VERSION:
        raise CodexPreflightFailure("unsupported_version")
    return ".".join(str(part) for part in parsed)


def _parse_login(
    result: PreflightCommandResult,
) -> Literal["chatgpt", "api_key", "unknown"]:
    raw_status = _decode_stdout(result, "credential_missing")
    identities: list[Literal["chatgpt", "api_key"]] = []
    for raw_line in raw_status.splitlines():
        value = " ".join(raw_line.split())
        if not value:
            continue
        identity = _known_login_identity(value)
        if identity is not None:
            identities.append(identity)
        elif _contains_login_identity(value):
            raise CodexPreflightFailure("credential_missing")
    if len(identities) != 1:
        raise CodexPreflightFailure("credential_missing")
    return identities[0]


def _known_login_identity(
    value: str,
) -> Literal["chatgpt", "api_key"] | None:
    if value == "Logged in using ChatGPT":
        return "chatgpt"
    if value == "Logged in using API key":
        return "api_key"
    if re.fullmatch(
        r"Logged in using an API key - (?:\*\*\*|[^\s]{8}\*\*\*[^\s]{5})",
        value,
    ):
        return "api_key"
    return None


def _contains_login_identity(value: str) -> bool:
    normalized = value.casefold()
    return "logged in" in normalized or "chatgpt" in normalized or "api key" in normalized


def _require_matching_root(result: PreflightCommandResult, workspace: Path) -> None:
    value = _decode_stdout(result, "workspace_root_mismatch")
    try:
        actual = Path(value).resolve(strict=True)
        expected = workspace.resolve(strict=True)
    except (OSError, RuntimeError):
        raise CodexPreflightFailure("workspace_root_mismatch") from None
    if actual != expected:
        raise CodexPreflightFailure("workspace_root_mismatch")


def _parse_probe(result: PreflightCommandResult) -> Mapping[str, str]:
    value = _decode_stdout(result, "sandbox_failed")
    try:
        document = json.loads(
            value,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_json_constant,
        )
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError, RecursionError):
        raise CodexPreflightFailure("sandbox_failed") from None
    if type(document) is not dict:
        raise CodexPreflightFailure("sandbox_failed")
    if set(document) != _PROBE_BOOLEAN_FIELDS | {"limits"}:
        raise CodexPreflightFailure("sandbox_failed")
    if any(document[name] is not True for name in _PROBE_BOOLEAN_FIELDS):
        raise CodexPreflightFailure("sandbox_failed")
    limits = document["limits"]
    if type(limits) is not dict or set(limits) != _LIMIT_NAMES:
        raise CodexPreflightFailure("sandbox_failed")
    if any(type(value) is not str or value not in _LIMIT_CLASSES for value in limits.values()):
        raise CodexPreflightFailure("sandbox_failed")
    return {name: limits[name] for name in ("cpu", "as", "nofile")}


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _reject_json_constant(_: str) -> None:
    raise ValueError("non-standard JSON constant")


async def _read_bounded(stream: asyncio.StreamReader, limit: int, *, retain: bool) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await stream.read(min(64 * 1024, limit - total + 1))
        if not chunk:
            return b"".join(chunks)
        total += len(chunk)
        if total > limit:
            raise CodexPreflightFailure("preflight_failed")
        if retain:
            chunks.append(chunk)


async def _finish_process_cleanup(
    process: asyncio.subprocess.Process,
    tasks: tuple[asyncio.Task[object], ...],
    streams: tuple[asyncio.StreamReader, ...],
    *,
    grace: float = _PROCESS_CLEANUP_GRACE,
) -> tuple[bool, ProcessGroupCleanupResult]:
    """Shield process-group cleanup and report cancellation plus stop evidence."""

    cleanup = asyncio.create_task(
        _cleanup_process_group(
            process,
            tasks,
            streams,
            grace=grace,
        )
    )
    interrupted = False
    while not cleanup.done():
        try:
            await asyncio.shield(cleanup)
        except asyncio.CancelledError:
            interrupted = True
    return interrupted, cleanup.result()


async def _cleanup_process_group(
    process: asyncio.subprocess.Process,
    tasks: tuple[asyncio.Task[object], ...],
    streams: tuple[asyncio.StreamReader, ...],
    *,
    grace: float,
) -> ProcessGroupCleanupResult:
    """Terminate one process group, then close paused pipes and reap it."""

    leader_was_running = process.returncode is None
    leader_stop: Literal["none", "terminate", "kill"] = "none"
    group_stop: Literal["none", "terminate", "kill"] = "none"
    group_id = process.pid
    group_gone = (
        not _process_group_alive(group_id) if os.name == "posix" else process.returncode is not None
    )

    if not group_gone and _signal_process_tree(process, TERMINATE_SIGNAL):
        group_stop = "terminate"
        if os.name == "posix":
            _, group_gone = await asyncio.gather(
                _bounded_reap(process, grace=grace),
                _wait_for_process_group_exit(group_id, grace=grace),
            )
        else:
            await _bounded_reap(process, grace=grace)
            group_gone = process.returncode is not None
        if leader_was_running and process.returncode is not None:
            leader_stop = "terminate"

    if not group_gone and _signal_process_tree(process, KILL_SIGNAL):
        group_stop = "kill"
        if os.name == "posix":
            _, group_gone = await asyncio.gather(
                _bounded_reap(process, grace=grace),
                _wait_for_process_group_exit(group_id, grace=grace),
            )
        else:
            await _bounded_reap(process, grace=grace)
            group_gone = process.returncode is not None
        if leader_was_running and leader_stop == "none" and process.returncode is not None:
            leader_stop = "kill"

    if process.returncode is None:
        await _bounded_reap(process, grace=grace)
        if os.name != "posix":
            group_gone = process.returncode is not None

    for task in tasks:
        task.cancel()
    try:
        async with asyncio.timeout(grace):
            await asyncio.gather(*tasks, return_exceptions=True)
    except TimeoutError:
        pass

    drained = False
    try:
        async with asyncio.timeout(grace):
            results = await asyncio.gather(
                *(_drain_to_eof(stream) for stream in streams),
                return_exceptions=True,
            )
        drained = all(result is None for result in results)
    except TimeoutError:
        pass
    if not drained:
        _close_process_pipes(process)
    await _CLEANUP_CLOCK.sleep(0)
    _close_process_transport(process)
    await _bounded_reap(process, grace=grace)
    await _CLEANUP_CLOCK.sleep(0)
    return ProcessGroupCleanupResult(
        leader_stop=leader_stop,
        group_stop=group_stop,
        leader_exited=process.returncode is not None,
        group_gone=group_gone,
    )


async def _bounded_reap(
    process: asyncio.subprocess.Process,
    *,
    grace: float,
) -> None:
    if process.returncode is not None:
        return
    try:
        async with asyncio.timeout(grace):
            await process.wait()
    except TimeoutError:
        pass


def _signal_process_tree(
    process: asyncio.subprocess.Process,
    selected_signal: int,
) -> bool:
    """Signal the whole tree, falling back to the leader handle where there is no tree reach."""
    if signal_tree(process.pid, selected_signal):
        return True
    if os.name == "posix" or process.returncode is not None:
        return False
    try:
        if selected_signal == TERMINATE_SIGNAL:
            process.terminate()
        else:
            process.kill()
    except (OSError, ProcessLookupError):
        return False
    return True


def _process_group_alive(group_id: int) -> bool:
    """Kept as the module's own name for a tree probe; the semantics live in process_tree."""
    return tree_alive(group_id)


async def _wait_for_process_group_exit(group_id: int, *, grace: float) -> bool:
    deadline = asyncio.get_running_loop().time() + grace
    while _process_group_alive(group_id):
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            return False
        await _CLEANUP_CLOCK.sleep(min(0.01, remaining))
    return True


async def _drain_to_eof(stream: asyncio.StreamReader) -> None:
    while await stream.read(64 * 1024):
        pass


def _close_process_pipes(process: asyncio.subprocess.Process) -> None:
    transport = process._transport  # type: ignore[attr-defined]
    for descriptor in (1, 2):
        pipe = transport.get_pipe_transport(descriptor)
        if pipe is not None and not pipe.is_closing():
            pipe.close()


def _close_process_transport(process: asyncio.subprocess.Process) -> None:
    transport = process._transport  # type: ignore[attr-defined]
    if not transport.is_closing():
        transport.close()


@asynccontextmanager
async def _empirical_probe(workspace: Path) -> AsyncIterator[tuple[str, ...]]:
    resolved_workspace = workspace.resolve(strict=True)
    sibling_dir = Path(
        tempfile.mkdtemp(
            prefix=".nova-audio-agent-codex-preflight-",
            dir=resolved_workspace.parent,
        )
    )
    canary = sibling_dir / "canary"
    marker = resolved_workspace / f".nova-audio-agent-codex-preflight-{uuid.uuid4().hex}"
    server: asyncio.AbstractServer | None = None

    async def close_connection(_: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        writer.close()
        await writer.wait_closed()

    try:
        canary.write_bytes(_CANARY_CONTENT)
        original_canary = _canary_fingerprint(canary)
        server = await asyncio.start_server(close_connection, "127.0.0.1", 0)
        sockets = server.sockets
        if not sockets:
            raise CodexPreflightFailure("sandbox_failed")
        port = sockets[0].getsockname()[1]
        yield (
            sys.executable,
            "-I",
            "-c",
            _PROBE_SCRIPT,
            str(resolved_workspace),
            str(canary),
            str(marker),
            str(port),
        )
        if _canary_fingerprint(canary) != original_canary:
            raise CodexPreflightFailure("sandbox_failed")
    finally:
        if server is not None:
            server.close()
        with suppress(OSError):
            marker.unlink()
        shutil.rmtree(sibling_dir)
        if server is not None:
            try:
                async with asyncio.timeout(_PROCESS_CLEANUP_GRACE):
                    await server.wait_closed()
            except TimeoutError:
                pass


def _canary_fingerprint(path: Path) -> tuple[object, ...]:
    try:
        metadata = path.lstat()
        content = path.read_bytes()
    except OSError:
        raise CodexPreflightFailure("sandbox_failed") from None
    if not stat.S_ISREG(metadata.st_mode) or content != _CANARY_CONTENT:
        raise CodexPreflightFailure("sandbox_failed")
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_uid,
        metadata.st_gid,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
        content,
    )
