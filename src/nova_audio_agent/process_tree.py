"""The one place that knows how to supervise a spawned process **and its descendants**.

Codex and AutoGLM both launch helpers that launch helpers. Stopping the leader alone is not
enough: a grandchild that survives keeps the workspace, the credentials, and the port it was
given. The two platforms reach a whole tree by completely different means, and every call
site used to carry its own `os.name` fork over the POSIX half:

- **POSIX** — `start_new_session=True` makes the child a session leader, so the group id
  equals the leader pid and one `killpg` reaches every descendant that has not called
  `setsid` itself.
- **Windows** — there is no group-signal equivalent. The child is spawned into a new process
  group (`CREATE_NEW_PROCESS_GROUP`) and the tree is torn down with `taskkill /T`, which
  walks the child list in the kernel and kills the descendants itself. Terminating the leader
  handle, which is what the old `os.name != "posix"` fallbacks did, orphans the rest.

Everything here is a *tree* operation. Reaping the leader stays with the caller that owns
it: on POSIX an exited-but-unreaped leader is still a member of its own group, so a tree is
not gone until whoever spawned it has awaited it.

Module boundary: this file holds the repo's only `killpg`, statically enforced by
tests/test_repo_guards.py.
"""

from __future__ import annotations

import os
import signal
import subprocess
from collections.abc import Callable, Sequence
from typing import Any

from nova_audio_agent.clock import Clock, RealClock

TaskkillRunner = Callable[[Sequence[str]], "subprocess.CompletedProcess[bytes]"]

# The two escalation steps, as plain ints so they survive Windows: `signal.SIGKILL` does not
# exist there, and merely naming it at a call site would raise. On POSIX they are the real
# signals, so a group signalled here is indistinguishable from a hand-written killpg.
TERMINATE_SIGNAL: int = signal.SIGTERM
KILL_SIGNAL: int = getattr(signal, "SIGKILL", 9)
# subprocess only defines this on Windows; the literal keeps the module importable — and the
# win32 branch testable — from a POSIX host.
CREATE_NEW_PROCESS_GROUP = 0x00000200
# taskkill's "the process is not there" exit code. Its POSIX twin is killpg's ESRCH, but the
# two callers here read it in opposite directions: terminate_tree treats 128 as success —
# nothing left to kill is exactly the state it wants — while signal_tree treats it as failure,
# the same as any other undelivered signal, since its contract is "did the request land".
TASKKILL_NOT_FOUND = 128
_TASKKILL_FAILED = 1
_POLL_INTERVAL = 0.01
# Bound on one taskkill pass. A wedged taskkill would otherwise block the asyncio loop inside
# the teardown path indefinitely; 5s is generous for a local process-tree walk.
TASKKILL_TIMEOUT_S = 5.0
_SUPERVISION_CLOCK = RealClock()


def spawn_supervision_kwargs() -> dict[str, Any]:
    """Spawn kwargs that put the child at the head of a tree this module can reach later.

    Merge into `create_subprocess_exec` / `Popen` keywords. On any other platform it adds
    nothing, which degrades to leader-only supervision rather than failing the spawn.
    """
    if os.name == "nt":
        return {"creationflags": CREATE_NEW_PROCESS_GROUP}
    if os.name == "posix":
        return {"start_new_session": True}
    return {}


def signal_tree(pid: int, selected_signal: int, *, runner: TaskkillRunner | None = None) -> bool:
    """Signal the whole tree led by `pid`; pass `TERMINATE_SIGNAL` or `KILL_SIGNAL`.

    Returns whether the request reached a tree at all: `False` covers both "already gone" and
    "not permitted", so callers that keep a leader handle can fall back to it.
    """
    if os.name == "posix":
        try:
            os.killpg(pid, selected_signal)
        except (OSError, ProcessLookupError):
            return False
        return True
    if os.name == "nt":
        return _taskkill(pid, forced=selected_signal == KILL_SIGNAL, runner=runner) == 0
    return False


def tree_alive(pid: int) -> bool:
    """Whether any member of `pid`'s tree still exists.

    POSIX only. Windows offers no cheap whole-tree probe — enumerating descendants needs a
    process snapshot per poll, and a leader handle answers for the leader alone — so this
    returns `False` there and callers fall back to the leader's own exit status, exactly as
    the pre-migration `os.name != "posix"` branches did. No caller needs more than that: on
    Windows `taskkill /T` performs the walk itself, so nothing has to poll for it.

    A `PermissionError` counts as alive: the group outlived us into someone else's hands.
    """
    if os.name != "posix":
        return False
    try:
        os.killpg(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


async def terminate_tree(
    pid: int,
    *,
    grace: float,
    runner: TaskkillRunner | None = None,
    clock: Clock | None = None,
) -> bool:
    """Stop the tree led by `pid` politely, then forcibly after `grace`. True when it is gone.

    For callers that only need the tree stopped. This has no production caller today — every
    real call site composes `signal_tree` and `tree_alive` itself instead, because it needs to
    interleave the escalation with draining pipes and reaping its own leader for step-level
    reporting. Kept here as the tested reference behaviour those call sites are composing.

    On POSIX the answer is observed (the group is polled until empty, or `grace` runs out
    twice over). On Windows it is taskkill's own verdict on the forced pass, since there is
    no tree probe to confirm it with.

    `pid` is a bare pid with no handle anchoring it to the tree it named when the caller
    observed it: nothing here holds a leader handle to detect that the pid was reaped and
    recycled in between. On Windows in particular, where a handle-based check is not part of
    this contract, a recycled pid could have this signal an entirely innocent tree. Callers
    must ensure the pid has not yet been reaped before calling this.
    """
    clock = clock or _SUPERVISION_CLOCK
    if os.name == "nt":
        _taskkill(pid, forced=False, runner=runner)
        await clock.sleep(grace)
        return _taskkill(pid, forced=True, runner=runner) in {0, TASKKILL_NOT_FOUND}
    if not tree_alive(pid):
        return True
    signal_tree(pid, TERMINATE_SIGNAL)
    if await _wait_tree_gone(pid, grace=grace, clock=clock):
        return True
    signal_tree(pid, KILL_SIGNAL)
    return await _wait_tree_gone(pid, grace=grace, clock=clock)


async def _wait_tree_gone(pid: int, *, grace: float, clock: Clock) -> bool:
    deadline = clock.now() + grace
    while tree_alive(pid):
        remaining = deadline - clock.now()
        if remaining <= 0:
            return False
        await clock.sleep(min(_POLL_INTERVAL, remaining))
    return True


def _taskkill(pid: int, *, forced: bool, runner: TaskkillRunner | None) -> int:
    """Run one `taskkill /T` pass over the tree and return its exit code; `forced` adds `/F`."""
    argv = ["taskkill", "/PID", str(pid), "/T"]
    if forced:
        argv.append("/F")
    try:
        return (runner or _run_captured)(argv).returncode
    except (OSError, subprocess.TimeoutExpired):
        # No taskkill on PATH, or one that wedged past TASKKILL_TIMEOUT_S, is a supervision
        # failure, never a crash mid-cleanup.
        return _TASKKILL_FAILED


def _run_captured(argv: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
    """Default runner: taskkill's chatter is captured, and its runtime bounded, so a wedged
    process can neither land on the host's stdio nor block the event loop indefinitely."""
    return subprocess.run(argv, capture_output=True, check=False, timeout=TASKKILL_TIMEOUT_S)
