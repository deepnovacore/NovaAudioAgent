from __future__ import annotations

from pydantic import ValidationError
import pytest

from nova_audio_agent.config import ProactivityParams, Settings, resolve_proactivity


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


def test_codex_working_interval_defaults_to_thirty_seconds() -> None:
    assert Settings(_env_file=None).codex_working_interval == 30.0


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
