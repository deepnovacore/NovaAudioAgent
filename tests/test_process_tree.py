"""One shared supervision module, checked on both branches: real POSIX groups, faked win32.

The POSIX cases spawn a real leader that outlives itself through a grandchild — the exact
shape of the bug this module exists for — and every wait is bounded. The win32 cases run on
this host with ``os.name`` monkeypatched, so the taskkill argv and the grace between the two
invocations are asserted without a Windows box.
"""

from __future__ import annotations

import asyncio
import os
import signal
import subprocess
import sys
from contextlib import suppress
from pathlib import Path

import pytest

from nova_audio_agent import process_tree

SLEEPER = "import time; time.sleep(30)"
BOUND = 5.0


class _RecordingClock:
    """Clock that logs its sleeps into a shared event list, so ordering is assertable."""

    def __init__(self, events: list[tuple[str, object]]) -> None:
        self._events = events
        self._now = 0.0

    def now(self) -> float:
        return self._now

    async def sleep(self, duration: float) -> None:
        self._events.append(("sleep", duration))
        self._now += duration


def _taskkill_runner(
    events: list[tuple[str, object]],
    returncode: int = 0,
):
    def runner(argv):  # noqa: ANN001 - mirrors the injected runner protocol
        events.append(("run", tuple(argv)))
        return subprocess.CompletedProcess(list(argv), returncode, b"", b"")

    return runner


async def _spawn_leader(*argv: str) -> asyncio.subprocess.Process:
    return await asyncio.create_subprocess_exec(
        sys.executable,
        "-I",
        *argv,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        **process_tree.spawn_supervision_kwargs(),
    )


@pytest.mark.skipif(os.name != "posix", reason="POSIX process groups")
def test_spawn_supervision_kwargs_opens_a_new_session_on_posix() -> None:
    assert process_tree.spawn_supervision_kwargs() == {"start_new_session": True}


def test_spawn_supervision_kwargs_opens_a_new_process_group_on_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(process_tree.os, "name", "nt")

    assert process_tree.spawn_supervision_kwargs() == {
        "creationflags": process_tree.CREATE_NEW_PROCESS_GROUP
    }
    assert process_tree.CREATE_NEW_PROCESS_GROUP == 0x00000200


def test_signal_tree_maps_the_two_steps_onto_group_signals(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent: list[tuple[int, int]] = []
    monkeypatch.setattr(process_tree.os, "name", "posix")
    monkeypatch.setattr(
        process_tree.os, "killpg", lambda pid, selected: sent.append((pid, selected))
    )

    assert process_tree.signal_tree(4321, process_tree.TERMINATE_SIGNAL) is True
    assert process_tree.signal_tree(4321, process_tree.KILL_SIGNAL) is True
    assert sent == [(4321, signal.SIGTERM), (4321, signal.SIGKILL)]


def test_the_escalation_signals_survive_a_platform_without_sigkill() -> None:
    """`signal.SIGKILL` is absent on Windows, so naming it at a call site would raise there."""
    assert process_tree.TERMINATE_SIGNAL == signal.SIGTERM
    assert process_tree.KILL_SIGNAL == 9
    assert process_tree.TERMINATE_SIGNAL != process_tree.KILL_SIGNAL


@pytest.mark.parametrize(
    ("error", "delivered"),
    [(ProcessLookupError(), False), (PermissionError(), False), (OSError(), False)],
)
def test_signal_tree_reports_an_undelivered_group_signal(
    monkeypatch: pytest.MonkeyPatch, error: OSError, delivered: bool
) -> None:
    monkeypatch.setattr(process_tree.os, "name", "posix")

    def killpg(pid: int, selected: int) -> None:
        raise error

    monkeypatch.setattr(process_tree.os, "killpg", killpg)

    assert process_tree.signal_tree(4321, process_tree.TERMINATE_SIGNAL) is delivered


@pytest.mark.parametrize(
    ("error", "alive"),
    [(None, True), (ProcessLookupError(), False), (PermissionError(), True), (OSError(), False)],
)
def test_tree_alive_reads_the_group_probe(
    monkeypatch: pytest.MonkeyPatch, error: OSError | None, alive: bool
) -> None:
    monkeypatch.setattr(process_tree.os, "name", "posix")
    probes: list[tuple[int, int]] = []

    def killpg(pid: int, selected: int) -> None:
        probes.append((pid, selected))
        if error is not None:
            raise error

    monkeypatch.setattr(process_tree.os, "killpg", killpg)

    assert process_tree.tree_alive(4321) is alive
    assert probes == [(4321, 0)]


def test_tree_alive_has_no_windows_probe_and_says_so(monkeypatch: pytest.MonkeyPatch) -> None:
    """Windows has no cheap whole-tree liveness probe, so callers fall back to the leader."""
    monkeypatch.setattr(process_tree.os, "name", "nt")

    assert process_tree.tree_alive(4321) is False


def test_signal_tree_drives_taskkill_over_the_whole_tree_on_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(process_tree.os, "name", "nt")
    events: list[tuple[str, object]] = []
    runner = _taskkill_runner(events)

    assert process_tree.signal_tree(4321, process_tree.TERMINATE_SIGNAL, runner=runner) is True
    assert process_tree.signal_tree(4321, process_tree.KILL_SIGNAL, runner=runner) is True
    assert events == [
        ("run", ("taskkill", "/PID", "4321", "/T")),
        ("run", ("taskkill", "/PID", "4321", "/T", "/F")),
    ]


def test_signal_tree_reports_a_windows_tree_that_taskkill_could_not_find(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(process_tree.os, "name", "nt")
    events: list[tuple[str, object]] = []
    runner = _taskkill_runner(events, returncode=process_tree.TASKKILL_NOT_FOUND)

    assert process_tree.signal_tree(4321, process_tree.TERMINATE_SIGNAL, runner=runner) is False


def test_the_default_windows_runner_captures_taskkill_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """taskkill must never leak onto the host's stdio, so the default runner captures."""
    monkeypatch.setattr(process_tree.os, "name", "nt")
    calls: list[tuple[tuple[str, ...], dict[str, object]]] = []

    def fake_run(argv, **kwargs):  # noqa: ANN001 - mirrors subprocess.run
        calls.append((tuple(argv), kwargs))
        return subprocess.CompletedProcess(list(argv), 0, b"", b"")

    monkeypatch.setattr(process_tree.subprocess, "run", fake_run)

    assert process_tree.signal_tree(4321, process_tree.TERMINATE_SIGNAL) is True
    (argv, kwargs) = calls[0]
    assert argv == ("taskkill", "/PID", "4321", "/T")
    assert kwargs["capture_output"] is True
    assert kwargs["check"] is False
    assert kwargs["timeout"] == process_tree.TASKKILL_TIMEOUT_S


def test_signal_tree_survives_a_wedged_taskkill_that_blows_the_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A hung taskkill must fail the call, not raise `TimeoutExpired` into the caller."""
    monkeypatch.setattr(process_tree.os, "name", "nt")

    def wedged(argv):  # noqa: ANN001 - mirrors the injected runner protocol
        raise subprocess.TimeoutExpired(cmd=list(argv), timeout=process_tree.TASKKILL_TIMEOUT_S)

    assert process_tree.signal_tree(4321, process_tree.TERMINATE_SIGNAL, runner=wedged) is False


async def test_terminate_tree_survives_a_wedged_taskkill_on_both_passes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The same wedge, reached through terminate_tree's polite-then-forced escalation."""
    monkeypatch.setattr(process_tree.os, "name", "nt")
    events: list[tuple[str, object]] = []

    def wedged(argv):  # noqa: ANN001 - mirrors the injected runner protocol
        raise subprocess.TimeoutExpired(cmd=list(argv), timeout=process_tree.TASKKILL_TIMEOUT_S)

    gone = await process_tree.terminate_tree(
        4321, grace=0.1, runner=wedged, clock=_RecordingClock(events)
    )

    assert gone is False


async def test_terminate_tree_escalates_taskkill_after_the_grace_on_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(process_tree.os, "name", "nt")
    events: list[tuple[str, object]] = []
    clock = _RecordingClock(events)

    gone = await process_tree.terminate_tree(
        4321, grace=2.5, runner=_taskkill_runner(events), clock=clock
    )

    assert gone is True
    assert events == [
        ("run", ("taskkill", "/PID", "4321", "/T")),
        ("sleep", 2.5),
        ("run", ("taskkill", "/PID", "4321", "/T", "/F")),
    ]


async def test_terminate_tree_reports_a_windows_tree_taskkill_could_not_force(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(process_tree.os, "name", "nt")
    events: list[tuple[str, object]] = []

    gone = await process_tree.terminate_tree(
        4321,
        grace=0.5,
        runner=_taskkill_runner(events, returncode=1),
        clock=_RecordingClock(events),
    )

    assert gone is False


@pytest.mark.real_time
@pytest.mark.skipif(os.name != "posix", reason="POSIX process groups")
async def test_signal_tree_and_tree_alive_follow_one_real_session_leader() -> None:
    process = await _spawn_leader("-c", SLEEPER)
    try:
        assert process_tree.tree_alive(process.pid) is True
        assert process_tree.signal_tree(process.pid, process_tree.KILL_SIGNAL) is True
        async with asyncio.timeout(BOUND):
            await process.wait()
    finally:
        with suppress(ProcessLookupError, PermissionError):
            os.killpg(process.pid, signal.SIGKILL)

    assert process_tree.tree_alive(process.pid) is False
    assert process_tree.signal_tree(process.pid, process_tree.TERMINATE_SIGNAL) is False


@pytest.mark.real_time
@pytest.mark.skipif(os.name != "posix", reason="POSIX process groups")
async def test_terminate_tree_reaches_a_grandchild_that_outlives_its_leader(
    tmp_path: Path,
) -> None:
    """The whole point: the leader exits first, and the grandchild must not survive it."""
    pid_file = tmp_path / "grandchild.pid"
    script = (
        "import subprocess,sys\n"
        "from pathlib import Path\n"
        "child=subprocess.Popen("
        f"[sys.executable,'-c',{SLEEPER!r}],"
        "stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n"
        "Path(sys.argv[1]).write_text(str(child.pid))\n"
    )
    leader = await _spawn_leader("-c", script, str(pid_file))
    async with asyncio.timeout(BOUND):
        assert await leader.wait() == 0
    grandchild = int(pid_file.read_text())

    try:
        assert process_tree.tree_alive(leader.pid) is True

        async with asyncio.timeout(BOUND):
            gone = await process_tree.terminate_tree(leader.pid, grace=1.0)

        assert gone is True
        assert process_tree.tree_alive(leader.pid) is False
        with pytest.raises(ProcessLookupError):
            os.kill(grandchild, 0)
    finally:
        with suppress(ProcessLookupError, PermissionError):
            os.kill(grandchild, signal.SIGKILL)


@pytest.mark.real_time
@pytest.mark.skipif(os.name != "posix", reason="POSIX process groups")
async def test_terminate_tree_escalates_to_kill_when_the_group_ignores_terminate() -> None:
    deaf = (
        "import signal,sys,time\n"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        "sys.stdout.write('deaf\\n'); sys.stdout.flush()\n"
        "time.sleep(30)\n"
    )
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-I",
        "-c",
        deaf,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        **process_tree.spawn_supervision_kwargs(),
    )
    assert process.stdout is not None
    try:
        async with asyncio.timeout(BOUND):
            # only signal once the handler is installed, or startup would eat the SIGTERM
            assert await process.stdout.readline() == b"deaf\n"
            gone = await process_tree.terminate_tree(process.pid, grace=0.2)
            await process.wait()
    finally:
        with suppress(ProcessLookupError, PermissionError):
            os.killpg(process.pid, signal.SIGKILL)

    assert gone is True
    assert process.returncode == -signal.SIGKILL


@pytest.mark.real_time
@pytest.mark.skipif(os.name != "posix", reason="POSIX process groups")
async def test_terminate_tree_leaves_an_already_gone_tree_alone() -> None:
    process = await _spawn_leader("-c", "pass")
    async with asyncio.timeout(BOUND):
        await process.wait()

    async with asyncio.timeout(BOUND):
        assert await process_tree.terminate_tree(process.pid, grace=1.0) is True
