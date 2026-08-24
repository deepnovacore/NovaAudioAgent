from __future__ import annotations

import os
from pathlib import Path

from pydantic import ValidationError
import pytest

import nova_audio_agent.config as config_module
from nova_audio_agent.config import (
    ConfigurationError,
    ProactivityParams,
    Settings,
    resolve_proactivity,
)


@pytest.mark.parametrize(
    ("preset", "expected"),
    [
        ("conservative", ProactivityParams(cooldown=120.0, fresh_window=20.0)),
        ("balanced", ProactivityParams(cooldown=60.0, fresh_window=30.0)),
        ("eager", ProactivityParams(cooldown=30.0, fresh_window=45.0)),
    ],
)
def test_proactivity_preset_derivation_table(
    preset: str,
    expected: ProactivityParams,
) -> None:
    settings = Settings(proactivity_preset=preset, _env_file=None)

    assert resolve_proactivity(settings) == expected


def test_proactivity_preset_defaults_to_balanced() -> None:
    settings = Settings(_env_file=None)

    assert settings.proactivity_preset == "balanced"
    assert resolve_proactivity(settings) == ProactivityParams(cooldown=60.0, fresh_window=30.0)


def test_invalid_proactivity_preset_is_rejected() -> None:
    with pytest.raises(ValidationError):
        Settings(proactivity_preset="aggressive", _env_file=None)


def test_explicit_suggestion_cooldown_overrides_preset() -> None:
    settings = Settings(
        proactivity_preset="conservative",
        suggestion_cooldown=5.0,
        _env_file=None,
    )

    resolved = resolve_proactivity(settings)

    assert resolved.cooldown == 5.0
    assert resolved.fresh_window == 20.0  # preset value, untouched


def test_explicit_fresh_window_overrides_preset() -> None:
    settings = Settings(
        proactivity_preset="eager",
        fresh_window=9.0,
        _env_file=None,
    )

    resolved = resolve_proactivity(settings)

    assert resolved.cooldown == 30.0  # preset value, untouched
    assert resolved.fresh_window == 9.0


def test_both_explicit_overrides_win_over_preset() -> None:
    settings = Settings(
        proactivity_preset="balanced",
        suggestion_cooldown=1.0,
        fresh_window=2.0,
        _env_file=None,
    )

    assert resolve_proactivity(settings) == ProactivityParams(cooldown=1.0, fresh_window=2.0)


@pytest.mark.parametrize("field", ["suggestion_cooldown", "fresh_window"])
@pytest.mark.parametrize("value", [-1.0, -0.1, float("nan"), float("inf"), float("-inf")])
def test_proactivity_override_rejects_negative_or_non_finite(field: str, value: float) -> None:
    # A negative cooldown fires the pool on every tick and a NaN window makes
    # every freshness comparison false: both are silent misbehaviour, not errors,
    # unless the override is validated where it enters the process.
    expected = f"NOVA_AUDIO_AGENT_{field.upper()}"
    with pytest.raises(ValidationError, match=expected):
        Settings(**{field: value}, _env_file=None)


@pytest.mark.parametrize("field", ["suggestion_cooldown", "fresh_window"])
@pytest.mark.parametrize("value", [0.0, 0.5, 30.0, 3600.0])
def test_proactivity_override_accepts_zero_and_positive(field: str, value: float) -> None:
    settings = Settings(**{field: value}, _env_file=None)

    assert getattr(settings, field) == value


@pytest.mark.parametrize("field", ["suggestion_cooldown", "fresh_window"])
def test_proactivity_override_stays_optional(field: str) -> None:
    assert getattr(Settings(_env_file=None), field) is None


def test_proactivity_override_rejects_a_negative_environment_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NOVA_AUDIO_AGENT_SUGGESTION_COOLDOWN", "-1")

    with pytest.raises(ValidationError, match="NOVA_AUDIO_AGENT_SUGGESTION_COOLDOWN"):
        Settings(_env_file=None)


def test_codex_working_interval_defaults_to_thirty_seconds() -> None:
    assert Settings(_env_file=None).codex_working_interval == 30.0


def test_codex_projects_are_unconditional_and_default_to_private_home_storage() -> None:
    settings = Settings(_env_file=None)

    assert not hasattr(settings, "codex_projects_enabled")
    assert settings.codex_managed_root == Path("~/.nova-audio-agent/workspaces")
    assert settings.codex_project_state_root == Path("~/.nova-audio-agent")


@pytest.mark.parametrize(
    ("root_name", "unsafe_mode"),
    [("state", 0o777), ("managed", 0o777), ("state", 0o1700), ("managed", 0o1700)],
)
def test_codex_project_roots_reject_existing_unsafe_permissions(
    tmp_path: Path,
    root_name: str,
    unsafe_mode: int,
) -> None:
    state = tmp_path / "state"
    managed = tmp_path / "managed"
    state.mkdir(mode=0o700)
    managed.mkdir(mode=0o700)
    selected = state if root_name == "state" else managed
    selected.chmod(unsafe_mode)

    with pytest.raises(ConfigurationError):
        Settings(
            codex_project_state_root=state,
            codex_managed_root=managed,
            _env_file=None,
        ).require_codex_projects()

    assert selected.stat().st_mode & 0o7777 == unsafe_mode


def test_codex_project_root_replacement_during_creation_is_not_chmodded(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    state = tmp_path / "state"
    managed = tmp_path / "managed"
    retained = tmp_path / "state-created-away"
    original_fstat = os.fstat
    replaced = False

    def replace_after_child_open(descriptor: int) -> os.stat_result:
        nonlocal replaced
        info = original_fstat(descriptor)
        current = os.lstat(state) if state.exists() else None
        if (
            not replaced
            and current is not None
            and info.st_dev == current.st_dev
            and info.st_ino == current.st_ino
        ):
            state.rename(retained)
            state.mkdir(mode=0o755)
            state.chmod(0o755)
            replaced = True
        return info

    monkeypatch.setattr(config_module.os, "fstat", replace_after_child_open)

    with pytest.raises(ConfigurationError):
        Settings(
            codex_project_state_root=state,
            codex_managed_root=managed,
            _env_file=None,
        ).require_codex_projects()

    assert replaced is True
    assert state.stat().st_mode & 0o7777 == 0o755


@pytest.mark.parametrize("target_name", ["state", "managed"])
def test_codex_project_root_replacement_before_first_stat_is_not_chmodded(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    target_name: str,
) -> None:
    state = tmp_path / "state"
    managed = tmp_path / "managed"
    target = state if target_name == "state" else managed
    retained = tmp_path / f"{target_name}-created-away"
    original_stat = os.stat
    replaced = False

    def replace_before_first_child_stat(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes] | int,
        *,
        dir_fd: int | None = None,
        follow_symlinks: bool = True,
    ) -> os.stat_result:
        nonlocal replaced
        if path == target.name and dir_fd is not None and not replaced:
            target.rename(retained)
            target.mkdir(mode=0o755)
            target.chmod(0o755)
            replaced = True
        return original_stat(path, dir_fd=dir_fd, follow_symlinks=follow_symlinks)

    monkeypatch.setattr(config_module.os, "stat", replace_before_first_child_stat)
    failed_closed = False
    try:
        Settings(
            codex_project_state_root=state,
            codex_managed_root=managed,
            _env_file=None,
        ).require_codex_projects()
    except ConfigurationError:
        failed_closed = True

    assert replaced is True
    assert target.stat().st_mode & 0o7777 == 0o755
    assert failed_closed is True


@pytest.mark.parametrize("value", [5.0, 30.0, 600.0])
def test_codex_working_interval_accepts_in_range_values(value: float) -> None:
    assert Settings(codex_working_interval=value, _env_file=None).codex_working_interval == value


@pytest.mark.parametrize("value", [0.0, 4.9, 600.1, 601.0, -5.0])
def test_codex_working_interval_out_of_range_is_rejected(value: float) -> None:
    with pytest.raises(ValidationError, match="NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL"):
        Settings(codex_working_interval=value, _env_file=None)


def test_codex_working_interval_parses_from_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL", "45.5")

    assert Settings(_env_file=None).codex_working_interval == 45.5


def test_proactivity_preset_parses_from_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NOVA_AUDIO_AGENT_PROACTIVITY_PRESET", "eager")

    assert Settings(_env_file=None).proactivity_preset == "eager"
