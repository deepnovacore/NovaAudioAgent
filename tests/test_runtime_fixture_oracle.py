from __future__ import annotations

import json

import pytest

from nova_audio_agent.canonical_json import canonical_json
from scripts import runtime_fixture_oracle
from scripts.runtime_fixture_oracle import (
    FixtureError,
    _parse_fastbrain_output,
    _validate_timeline,
    fixture_directories,
    load_fixture,
    run_fixture,
)


@pytest.mark.asyncio
async def test_python_oracle_matches_all_committed_node_runtime_fixtures() -> None:
    directories = fixture_directories()
    assert directories
    for directory in directories:
        fixture = load_fixture(directory)
        actual = await run_fixture(fixture)
        assert canonical_json(actual) == canonical_json(fixture["expected"]), directory.name


@pytest.mark.asyncio
async def test_python_oracle_rejects_unused_executor_stimuli() -> None:
    directory = next(
        path for path in fixture_directories() if path.name == "malformed-fastbrain-output"
    )
    fixture = load_fixture(directory)
    fixture["input"]["stimuli"].append(
        {
            "at": 1,
            "kind": "executor_complete",
            "dispatch_index": 0,
            "outcome": "ok",
            "trust": "trusted_system",
            "content": {"unused": True},
            "refs": [],
        }
    )
    with pytest.raises(FixtureError, match="unused executor stimulus plans"):
        await run_fixture(fixture)


def test_python_oracle_rejects_noop_clock_advance() -> None:
    directory = next(path for path in fixture_directories() if path.name == "stale-model-action")
    fixture = load_fixture(directory)
    fixture["input"]["stimuli"].insert(1, {"at": 1, "kind": "advance_clock", "to": 1})

    with pytest.raises(FixtureError, match="must strictly advance"):
        _validate_timeline(fixture["input"])


@pytest.mark.parametrize(
    "action",
    [
        {
            "act": "delegate",
            "delegate": {
                "executor": "slow_sim",
                "op": "set_light",
                "request": {"nested": {"number": float("inf")}},
                "origin_ref": "conversation:1",
            },
        },
        {
            "act": "update",
            "update": {
                "target": "intent",
                "delta": {"nested": [{"number": float("inf")}]},
            },
        },
    ],
)
def test_python_fastbrain_parser_rejects_non_finite_nested_json(
    action: dict[str, object],
) -> None:
    output = {"speak": {"act": "none"}, "action": action}

    assert _parse_fastbrain_output(output) is None


@pytest.mark.asyncio
async def test_python_oracle_export_escapes_lone_surrogates(tmp_path, monkeypatch) -> None:
    directory = tmp_path / "surrogate-export"
    directory.mkdir()
    actual = {"schema_version": 1, "diagnostics": [{"code": "bad-\ud800"}]}

    async def fake_run_fixture(_fixture):
        return actual

    monkeypatch.setattr(runtime_fixture_oracle, "load_fixture", lambda _directory: {})
    monkeypatch.setattr(runtime_fixture_oracle, "run_fixture", fake_run_fixture)

    await runtime_fixture_oracle.export_fixtures([directory])

    encoded = (directory / "expected.json").read_bytes()
    assert b"\\ud800" in encoded
    assert json.loads(encoded)["diagnostics"][0]["code"] == "bad-\ud800"


def test_python_oracle_diff_escapes_lone_surrogates() -> None:
    rendered = runtime_fixture_oracle._fixture_diff(
        "surrogate-diff",
        {"value": "expected"},
        {"value": "bad-\udfff"},
    )

    assert "\\udfff" in rendered
    rendered.encode("utf-8")


@pytest.mark.asyncio
async def test_python_oracle_preserves_declared_cross_source_same_time_order() -> None:
    directory = next(
        path for path in fixture_directories() if path.name == "live-observation-before-handoff"
    )
    fixture = load_fixture(directory)
    fixture["input"]["stimuli"].insert(
        2,
        {"at": 1, "kind": "user_input", "text": "what is happening now?"},
    )
    fixture["input"]["ports"]["fastbrain"].append(
        {
            "delay": 0,
            "output": {"speak": {"act": "none"}, "action": {"act": "none"}},
        }
    )

    actual = await run_fixture(fixture)

    same_time = [
        event["kind"]
        for event in actual["applied_events"]
        if event["ts"] == 1 and event["kind"] in {"observation", "user_input"}
    ]
    assert same_time == ["observation", "user_input"]
