import os
from pathlib import Path
from types import SimpleNamespace

import conftest as suite_config
import pytest
from repository_scan import parsed_python, python_nodes, repository_python_files, source_text

_LOCAL_BUDGET = "3.8"
_LOCAL_REPLAY_BUDGET = "1.5"
_CI_BUDGET = "6.5"
_CI_REPLAY_BUDGET = "4.0"


def test_repository_scan_reuses_one_text_and_ast_snapshot() -> None:
    runtime = next(
        path for path in repository_python_files() if path.as_posix().endswith("runtime.py")
    )

    assert source_text(runtime) is source_text(runtime)
    assert parsed_python(runtime) is parsed_python(runtime)
    assert python_nodes(runtime) is python_nodes(runtime)
    assert parsed_python(runtime).body


def test_ci_overrides_both_budgets_and_the_local_defaults_stay_pinned() -> None:
    # The numbers live in two places and drift silently otherwise. They are not named in this
    # test's own name, which is how the previous pin went stale.
    workflow = Path(".github/workflows/ci.yml").read_text(encoding="utf-8")
    conftest_source = Path("tests/conftest.py").read_text(encoding="utf-8")

    assert f'NOVA_AUDIO_AGENT_TEST_TIME_BUDGET: "{_CI_BUDGET}"' in workflow
    assert f'NOVA_AUDIO_AGENT_FIXTURE_REPLAY_BUDGET: "{_CI_REPLAY_BUDGET}"' in workflow
    assert (
        f'os.environ.get("NOVA_AUDIO_AGENT_TEST_TIME_BUDGET", "{_LOCAL_BUDGET}")' in conftest_source
    )
    assert (
        f'os.environ.get("NOVA_AUDIO_AGENT_FIXTURE_REPLAY_BUDGET", "{_LOCAL_REPLAY_BUDGET}")'
        in conftest_source
    )
    # CI machines are slower, so its overrides must be looser than local, never tighter.
    assert float(_CI_BUDGET) > float(_LOCAL_BUDGET)
    assert float(_CI_REPLAY_BUDGET) > float(_LOCAL_REPLAY_BUDGET)


def test_configured_budget_keeps_headroom_but_rejects_a_larger_regression(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    record = suite_config.pytest_runtest_logreport

    # The default pin must not defeat the documented slow-machine override.
    if "NOVA_AUDIO_AGENT_TEST_TIME_BUDGET" not in os.environ:
        assert suite_config._BUDGET == float(_LOCAL_BUDGET)
    if "NOVA_AUDIO_AGENT_FIXTURE_REPLAY_BUDGET" not in os.environ:
        assert suite_config._REPLAY_BUDGET == float(_LOCAL_REPLAY_BUDGET)

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


def test_fixture_replay_is_charged_to_its_own_budget_not_the_deterministic_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Replay is deterministic compute that grows with the fixture set. Charging it to the same
    # number as everything else is what forced the bar up last time.
    record = suite_config.pytest_runtest_logreport
    monkeypatch.setattr(suite_config, "_test_elapsed", 0.0)
    monkeypatch.setattr(suite_config, "_replay_elapsed", 0.0)
    monkeypatch.setattr(suite_config, "_BUDGET", 1.0)
    monkeypatch.setattr(suite_config, "_REPLAY_BUDGET", 10.0)

    record(SimpleNamespace(when="call", duration=5.0, keywords={"fixture_replay": True}))
    record(SimpleNamespace(when="call", duration=0.5, keywords={}))

    assert suite_config._test_elapsed == 0.5
    assert suite_config._replay_elapsed == 5.0

    session = SimpleNamespace(exitstatus=0)
    suite_config.pytest_sessionfinish(session, exitstatus=0)
    assert session.exitstatus == 0, (
        "replay under its own budget must not fail the deterministic one"
    )


def test_an_overrunning_replay_budget_fails_the_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(suite_config, "_test_elapsed", 0.0)
    monkeypatch.setattr(suite_config, "_replay_elapsed", 0.0)
    monkeypatch.setattr(suite_config, "_BUDGET", 10.0)
    monkeypatch.setattr(suite_config, "_REPLAY_BUDGET", 1.0)

    suite_config.pytest_runtest_logreport(
        SimpleNamespace(when="call", duration=1.1, keywords={"fixture_replay": True})
    )
    session = SimpleNamespace(exitstatus=0)
    suite_config.pytest_sessionfinish(session, exitstatus=0)

    assert session.exitstatus == 1


def test_a_real_time_test_is_charged_to_neither_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(suite_config, "_test_elapsed", 0.0)
    monkeypatch.setattr(suite_config, "_replay_elapsed", 0.0)

    suite_config.pytest_runtest_logreport(
        SimpleNamespace(when="call", duration=100.0, keywords={"real_time": True})
    )
    suite_config.pytest_runtest_logreport(
        SimpleNamespace(
            when="call", duration=100.0, keywords={"real_time": True, "fixture_replay": True}
        )
    )

    assert suite_config._test_elapsed == 0.0
    assert suite_config._replay_elapsed == 0.0
