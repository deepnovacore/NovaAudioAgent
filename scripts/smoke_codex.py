"""Explicit local smoke for the bounded Codex executor."""

from __future__ import annotations

import argparse
import asyncio
import os
import re
import stat
import subprocess
import sys
import tempfile
from collections.abc import Awaitable, Callable, Mapping
from contextlib import AbstractContextManager
from pathlib import Path
from typing import Protocol

from nova_audio_agent.clock import RealClock
from nova_audio_agent.config import Settings
from nova_audio_agent.events import WakeReason
from nova_audio_agent.executors.codex import CodexAdapter
from nova_audio_agent.executors.codex_transport import CodexTransport
from nova_audio_agent.ports import DispatchContext, DelegateRequest, bind_delegate

SMOKE_FILE = "NOVA_AUDIO_AGENT_CODEX_SMOKE.txt"
SMOKE_BYTES = b"nova-audio-agent codex smoke\n"
WORK_ORDER = (
    "Create exactly one file named NOVA_AUDIO_AGENT_CODEX_SMOKE.txt at the repository root with exact "
    'UTF-8 contents "nova-audio-agent codex smoke" followed by one newline. Do not modify any other file.'
)


class _CodexSettings(Protocol):
    def require_codex(self) -> tuple[Path, str, str | None]: ...


class _Transport(Protocol):
    async def preflight(self) -> Mapping[str, object]: ...


class _Adapter(Protocol):
    status: object

    async def dispatch(self, op: str, request: dict[str, str], ctx: DispatchContext) -> object: ...


TransportFactory = Callable[[str, Path, str | None], _Transport]
AdapterFactory = Callable[[_Transport, Path], _Adapter]
TemporaryDirectoryFactory = Callable[[], AbstractContextManager[str]]
GitInit = Callable[[Path], None]
Emit = Callable[[str], None]
TemporaryRoot = Callable[[], Path]
Runner = Callable[[bool], Awaitable[int]]

_VERSION = re.compile(r"\d+\.\d+\.\d+\Z")
_IDENTITIES = frozenset({"chatgpt", "api_key", "unknown"})
_POLICIES = frozenset({"saved_login", "process_only"})
_LIMIT_CLASSES = frozenset({"finite", "unbounded", "unavailable"})


def _transport(binary: str, workspace: Path, api_key: str | None) -> CodexTransport:
    return CodexTransport(binary=binary, workspace=workspace, api_key=api_key)


def _adapter(transport: _Transport, _: Path) -> CodexAdapter:
    if not isinstance(transport, CodexTransport):
        raise TypeError("invalid transport")
    return CodexAdapter(transport)


def _git_init(repository: Path) -> None:
    subprocess.run(
        ("git", "init", str(repository)),
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _status_value(status: object, production_name: str, fixture_name: str) -> bool:
    value = getattr(status, production_name, getattr(status, fixture_name, False))
    return value is True


def _completed_zero_exit(adapter: _Adapter, handoff: object) -> bool:
    content = getattr(handoff, "content", None)
    status = adapter.status
    protocol = content.get("protocol") if type(content) is dict else None
    return (
        getattr(handoff, "outcome", None) == "ok"
        and type(content) is dict
        and content.get("code") == "completed"
        and type(protocol) is dict
        and protocol.get("terminal") == "completed"
        and protocol.get("transport_closed") is True
        and _status_value(status, "process_exited", "exited")
        and getattr(status, "terminal", None) == "completed"
        and getattr(status, "exit_code", None) == 0
    )


def paths_are_disjoint(first: Path, second: Path) -> bool:
    """Return whether neither resolved path can contain the other."""

    try:
        left = first.resolve()
        right = second.resolve()
    except (OSError, RuntimeError):
        return False
    return not left.is_relative_to(right) and not right.is_relative_to(left)


def _verify_repository(repository: Path) -> bool:
    try:
        if not stat.S_ISDIR(os.lstat(repository).st_mode):
            return False
        if {path.name for path in repository.iterdir()} != {".git", SMOKE_FILE}:
            return False
        if not stat.S_ISDIR(os.lstat(repository / ".git").st_mode):
            return False
        target = repository / SMOKE_FILE
        if not stat.S_ISREG(os.lstat(target).st_mode):
            return False
        return target.read_bytes() == SMOKE_BYTES
    except OSError:
        return False


def _safe_preflight_summary(report: object) -> str | None:
    if type(report) is not dict or set(report) != {
        "version",
        "root_matches",
        "mount",
        "subprocess",
        "network",
        "credential",
        "limits",
    }:
        return None
    version = report["version"]
    credential = report["credential"]
    limits = report["limits"]
    if type(version) is not str or _VERSION.fullmatch(version) is None:
        return None
    if report["root_matches"] is not True:
        return None
    if report["mount"] != "workspace_only":
        return None
    if report["subprocess"] != "contained" or report["network"] != "blocked":
        return None
    if type(credential) is not dict or set(credential) != {"present", "identity", "policy"}:
        return None
    if credential["present"] is not True:
        return None
    identity = credential["identity"]
    policy = credential["policy"]
    if type(identity) is not str or identity not in _IDENTITIES:
        return None
    if type(policy) is not str or policy not in _POLICIES:
        return None
    if type(limits) is not dict or set(limits) != {"cpu", "as", "nofile"}:
        return None
    if any(type(value) is not str or value not in _LIMIT_CLASSES for value in limits.values()):
        return None
    return (
        f"Codex preflight passed: version={version} credential={identity}/{policy} "
        "root=matched write=workspace_only child=contained network=blocked "
        f"limits=cpu:{limits['cpu']},as:{limits['as']},nofile:{limits['nofile']}"
    )


async def run_smoke(
    *,
    apply: bool,
    settings: _CodexSettings | None = None,
    transport_factory: TransportFactory = _transport,
    adapter_factory: AdapterFactory = _adapter,
    temporary_directory: TemporaryDirectoryFactory = tempfile.TemporaryDirectory,
    temporary_root: TemporaryRoot = lambda: Path(tempfile.gettempdir()),
    git_init: GitInit = _git_init,
    emit: Emit = print,
) -> int:
    """Run preflight, or one independent exact-file smoke in a disposable repository."""

    try:
        configured = Settings() if settings is None else settings
        workspace, binary, api_key = configured.require_codex()
        workspace = workspace.resolve()
    except Exception:
        emit("Codex smoke failed")
        return 1

    if not apply:
        try:
            report = await transport_factory(binary, workspace, api_key).preflight()
            summary = _safe_preflight_summary(report)
            if summary is None:
                raise ValueError("unsafe preflight report")
        except Exception:
            emit("Codex smoke failed")
            return 1
        emit(summary)
        return 0

    manager: AbstractContextManager[str] | None = None
    result = 1
    entered = False
    try:
        if not paths_are_disjoint(workspace, Path(temporary_root())):
            raise ValueError("temporary root overlaps workspace")
        manager = temporary_directory()
        repository = Path(manager.__enter__())
        entered = True
        repository = repository.resolve()
        if not paths_are_disjoint(workspace, repository):
            raise ValueError("temporary repository overlaps workspace")
        git_init(repository)
        adapter = adapter_factory(transport_factory(binary, repository, api_key), repository)
        clock = RealClock()
        delegate = bind_delegate(
            DelegateRequest(
                executor="codex",
                op="run",
                request={"work_order": WORK_ORDER},
                origin_ref="smoke:0",
            ),
            wake_reason=WakeReason(kind="smoke", priority=0, routing_class="user_awaited"),
            op=CodexAdapter.manifest.ops[0],
            now=clock.now(),
            delegate_id="smoke",
        )
        task = asyncio.create_task(
            adapter.dispatch("run", {"work_order": WORK_ORDER}, DispatchContext(clock, delegate))
        )
        running_observed = False
        while not task.done() and not running_observed:
            await clock.sleep(0)
            running_observed = _status_value(adapter.status, "process_running", "running")
        handoff = await task
        if (
            running_observed
            and _completed_zero_exit(adapter, handoff)
            and _verify_repository(repository)
        ):
            result = 0
    except Exception:
        result = 1
    finally:
        if entered and manager is not None:
            try:
                manager.__exit__(None, None, None)
            except Exception:
                result = 1

    emit("Codex apply smoke passed" if result == 0 else "Codex smoke failed")
    return result


def main(argv: list[str] | None = None, *, runner: Runner | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Run the local Codex smoke. By default, preflight the configured workspace "
            "with write/remove checks."
        )
    )
    parser.add_argument(
        "--apply", action="store_true", help="run the apply smoke in a disposable repository"
    )
    args = parser.parse_args(argv)
    try:
        if runner is None:
            return asyncio.run(run_smoke(apply=args.apply))
        return asyncio.run(runner(args.apply))
    except Exception:
        print("Codex smoke failed")
        return 1


if __name__ == "__main__":
    sys.exit(main())
