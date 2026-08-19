"""Two separate time budgets: deterministic test phases, and fixture replay.

The first guard catches setup, call, or teardown phases that actually wait on the wall clock,
without charging collection and import time, which varies with the host. It's paired with the
static case in tests/test_wallclock_hygiene.py: the static case names offending files, while this
one catches waiting behavior that slips through. Tests marked ``real_time`` exercise OS/process
integration in the default suite and are charged to neither budget.

Fixture replay is accounted separately. Replaying a committed fixture through real production code
is added deterministic compute, not a test waiting on the wall clock, and it grows with the fixture
set -- so charging it to the same number as everything else meant the bar had to move every time a
scenario was added, which is the opposite of what a bar is for. The previous default rose from 3.5s
to 4.5s for exactly that reason. Tests marked ``fixture_replay`` are now charged to their own
budget, and the deterministic bar is back to measuring what it was meant to measure.

Set NOVA_AUDIO_AGENT_TEST_TIME_REPORT=1 to print both totals, which is how the budgets below were
chosen. Measured on the development machine with 2,805 tests: the deterministic phase is 3.291s
against a 3.8s bar, and replay is 0.353s across 22 scenarios against a 1.5s bar. Splitting the two
brought the deterministic phase back to 3.291s from the 3.4-3.7s that forced the last raise, which
is within noise of the 3.244s it measured before any of this migration started.

The replay bar carries more headroom than the deterministic one on purpose: it has to absorb the
scenarios this migration still has to add, at roughly 16ms each, while still failing on a replay
path that starts waiting on the wall clock. Re-derive it once the session fixture set is complete.

Either can be overridden via NOVA_AUDIO_AGENT_TEST_TIME_BUDGET and
NOVA_AUDIO_AGENT_FIXTURE_REPLAY_BUDGET, for troubleshooting on extremely slow machines. CI keeps
its own overrides.
"""

from __future__ import annotations

import os

_BUDGET = float(os.environ.get("NOVA_AUDIO_AGENT_TEST_TIME_BUDGET", "3.8"))
_REPLAY_BUDGET = float(os.environ.get("NOVA_AUDIO_AGENT_FIXTURE_REPLAY_BUDGET", "1.5"))
_REPORT = os.environ.get("NOVA_AUDIO_AGENT_TEST_TIME_REPORT") == "1"

_test_elapsed = 0.0
_replay_elapsed = 0.0


def pytest_sessionstart(session) -> None:  # noqa: ANN001 - pytest hook signature
    global _test_elapsed, _replay_elapsed
    _test_elapsed = 0.0
    _replay_elapsed = 0.0


def pytest_runtest_logreport(report) -> None:  # noqa: ANN001 - pytest hook signature
    global _test_elapsed, _replay_elapsed
    if report.when not in ("setup", "call", "teardown"):
        return
    if "real_time" in report.keywords:
        return
    if "fixture_replay" in report.keywords:
        _replay_elapsed += report.duration
        return
    _test_elapsed += report.duration


def pytest_sessionfinish(session, exitstatus) -> None:  # noqa: ANN001 - pytest hook signature
    if _REPORT:
        print(
            f"\n[nova-audio-agent] 确定性阶段 {_test_elapsed:.3f}s / 预算 {_BUDGET:.3f}s；"
            f"夹具回放 {_replay_elapsed:.3f}s / 预算 {_REPLAY_BUDGET:.3f}s"
        )
    overruns = []
    if _test_elapsed > _BUDGET:
        overruns.append(
            f"确定性测试用例阶段累计耗时 {_test_elapsed:.3f}s，超过预算 {_BUDGET:.3f}s。"
            f"\n            确定性阶段要求 < {_BUDGET:g}s：有用例真的在等，或执行路径明显退化。"
        )
    if _replay_elapsed > _REPLAY_BUDGET:
        overruns.append(
            f"夹具回放阶段累计耗时 {_replay_elapsed:.3f}s，超过预算 {_REPLAY_BUDGET:.3f}s。"
            f"\n            回放是确定性计算，超预算说明replay路径退化，不是场景变多的正常代价——"
            f"\n            先确认单场景成本没变，再考虑调整预算。"
        )
    if not overruns:
        return
    print("\n[nova-audio-agent] " + "\n[nova-audio-agent] ".join(overruns))
    session.exitstatus = 1
