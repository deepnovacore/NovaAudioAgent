from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.realtime_session_oracle import (
    FIXTURE_ROOT,
    SCHEMA_PATH,
    FixtureError,
    fixture_directories,
    load_fixture,
    main,
    run_fixture,
)

pytestmark = pytest.mark.fixture_replay


def test_python_realtime_session_matches_the_committed_goldens(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main(["check"]) == 0
    assert "parity passed" in capsys.readouterr().out


def test_every_scenario_declares_what_it_covers_and_scripts_at_least_one_step() -> None:
    directories = fixture_directories()
    assert directories
    for directory in directories:
        fixture = load_fixture(directory)
        manifest = fixture["manifest"]
        assert manifest["covers"], f"{directory.name} must say what it covers"
        assert fixture["input"]["steps"], f"{directory.name} must script at least one step"
        assert len(fixture["expected"]["observations"]) == len(fixture["input"]["steps"]), (
            f"{directory.name} must observe every step"
        )


def test_the_schema_rejects_an_unknown_field() -> None:
    # The schema is generated from the Node Zod contract, so a fixture that only one runtime
    # accepts is a contract break rather than a tolerated extra.
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    assert schema["additionalProperties"] is False


@pytest.mark.asyncio
async def test_an_unconsumed_id_fails_rather_than_being_tolerated(tmp_path: Path) -> None:
    # An id the run never asked for means the two runtimes disagree about how much they allocate.
    fixture = load_fixture(FIXTURE_ROOT / "normal-response")
    fixture["input"]["ids"] = [*fixture["input"]["ids"], "generation-never-used"]

    with pytest.raises(FixtureError, match="unconsumed"):
        await run_fixture(fixture)


@pytest.mark.asyncio
async def test_an_exhausted_id_sequence_fails_rather_than_inventing_one() -> None:
    fixture = load_fixture(FIXTURE_ROOT / "normal-response")
    fixture["input"]["ids"] = fixture["input"]["ids"][:-1]

    with pytest.raises(FixtureError, match="exhausted"):
        await run_fixture(fixture)


@pytest.mark.asyncio
async def test_an_undeclared_pcm_fill_capability_fails() -> None:
    directory = FIXTURE_ROOT / "normal-response"
    fixture = load_fixture(directory)
    audio = next(
        step
        for step in fixture["input"]["steps"]
        if step["kind"] == "provider_event" and step["event"]["kind"] == "response_audio_delta"
    )
    audio["event"]["pcm"] = {"pcm_fill": {"byte": 1, "length": 4}}

    from scripts.realtime_session_oracle import _validate_requires

    with pytest.raises(FixtureError, match="pcm_fixture"):
        _validate_requires(fixture)


def test_the_reducer_refuses_every_event_it_does_not_handle() -> None:
    # Falling through is a decision, not an omission: a delta belongs to the caption projection
    # and must not reach Floor, Memory, or delivery through the reducer.
    fixture = load_fixture(FIXTURE_ROOT / "unhandled-event-variants")
    refused = {
        fixture["input"]["steps"][observation["step"]]["event"]["kind"]
        for observation in fixture["expected"]["observations"]
        if observation["kind"] == "provider_event" and observation["result"] is False
    }
    assert refused == {
        "user_transcript_delta",
        "response_transcript_delta",
        "item_confirmed",
        "response_cancel_rejected",
        "provider_error",
    }
