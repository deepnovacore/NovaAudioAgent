"""Deterministic per-test phase budget: unmarked test phases total < 3.5s.

This guard catches setup, call, or teardown phases that actually wait on the wall clock without
charging collection and import time, which varies with the host. It's paired with the static case
in tests/test_wallclock_hygiene.py: the static case names offending files, while this one catches
waiting behavior that slips through. Tests explicitly marked ``real_time`` exercise OS/process
integration in the default suite but are not charged to the deterministic budget.

The user-authorized local default is 3.5 seconds; CI retains its 7.5-second override. The budget
can otherwise be overridden via NOVA_AUDIO_AGENT_TEST_TIME_BUDGET only for troubleshooting on extremely
slow machines.
"""

from __future__ import annotations

import os

_BUDGET = float(os.environ.get("NOVA_AUDIO_AGENT_TEST_TIME_BUDGET", "3.5"))
_test_elapsed = 0.0


def pytest_sessionstart(session) -> None:  # noqa: ANN001 - pytest hook signature
    global _test_elapsed
    _test_elapsed = 0.0


def pytest_runtest_logreport(report) -> None:  # noqa: ANN001 - pytest hook signature
    global _test_elapsed
    if report.when in ("setup", "call", "teardown") and "real_time" not in report.keywords:
        _test_elapsed += report.duration


def pytest_sessionfinish(session, exitstatus) -> None:  # noqa: ANN001 - pytest hook signature
    if _test_elapsed <= _BUDGET:
        return
    print(
        f"\n[nova-audio-agent] 确定性测试用例阶段累计耗时 {_test_elapsed:.3f}s，"
        f"超过预算 {_BUDGET:.3f}s。"
        f"\n            确定性阶段要求 < {_BUDGET:g}s：有用例真的在等，或执行路径明显退化。"
    )
    session.exitstatus = 1
