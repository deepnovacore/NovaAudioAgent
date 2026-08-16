import os
from pathlib import Path
from types import SimpleNamespace

import conftest as suite_config
import pytest
from repository_scan import parsed_python, python_nodes, repository_python_files, source_text


def test_repository_scan_reuses_one_text_and_ast_snapshot() -> None:
    runtime = next(
        path for path in repository_python_files() if path.as_posix().endswith("runtime.py")
    )

    assert source_text(runtime) is source_text(runtime)
    assert parsed_python(runtime) is parsed_python(runtime)
    assert python_nodes(runtime) is python_nodes(runtime)
    assert parsed_python(runtime).body


def test_ci_budget_is_7_5_seconds_while_local_default_stays_3_5_seconds() -> None:
    workflow = Path(".github/workflows/ci.yml").read_text(encoding="utf-8")
    conftest_source = Path("tests/conftest.py").read_text(encoding="utf-8")

    assert 'NOVA_AUDIO_AGENT_TEST_TIME_BUDGET: "7.5"' in workflow
    assert 'os.environ.get("NOVA_AUDIO_AGENT_TEST_TIME_BUDGET", "3.5")' in conftest_source


def test_configured_budget_keeps_headroom_but_rejects_a_larger_regression(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    record = suite_config.pytest_runtest_logreport

    # The default pin must not defeat the documented slow-machine override.
    if "NOVA_AUDIO_AGENT_TEST_TIME_BUDGET" not in os.environ:
        assert suite_config._BUDGET == 3.5

    monkeypatch.setattr(suite_config, "_BUDGET", 3.0)
    monkeypatch.setattr(suite_config, "_test_elapsed", 0.0)
    record(SimpleNamespace(when="call", duration=2.9, keywords={}))
    within_budget = SimpleNamespace(exitstatus=0)
    suite_config.pytest_sessionfinish(within_budget, exitstatus=0)

    monkeypatch.setattr(suite_config, "_test_elapsed", 0.0)
    record(SimpleNamespace(when="call", duration=3.1, keywords={}))
    regression = SimpleNamespace(exitstatus=0)
    suite_config.pytest_sessionfinish(regression, exitstatus=0)

    assert within_budget.exitstatus == 0
    assert regression.exitstatus == 1


def test_time_budget_counts_unmarked_test_phases_but_not_collection_or_real_time(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    record = getattr(suite_config, "pytest_runtest_logreport", None)
    assert record is not None, "the suite budget must observe per-test reports"

    try:
        monkeypatch.setattr(suite_config, "_test_elapsed", 0.0)
        monkeypatch.setattr(suite_config, "_BUDGET", 0.3)
        record(SimpleNamespace(when="setup", duration=10.0, keywords={}))
        record(SimpleNamespace(when="call", duration=0.4, keywords={}))
        record(SimpleNamespace(when="teardown", duration=10.0, keywords={}))
        record(SimpleNamespace(when="collect", duration=100.0, keywords={}))
        record(SimpleNamespace(when="call", duration=100.0, keywords={"real_time": True}))

        session = SimpleNamespace(exitstatus=0)
        suite_config.pytest_sessionfinish(session, exitstatus=0)

        assert suite_config._test_elapsed == 20.4
        assert session.exitstatus == 1
    finally:
        monkeypatch.undo()
