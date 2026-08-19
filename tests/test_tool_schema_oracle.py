"""Gate the Python side of compiled tool-schema parity.

Tool names, descriptions, and parameter schemas all reach the model, and the
wire-name mangling plus the injected ``origin_ref`` are contract behavior. The Node
port asserts the same committed golden, so agreement is transitive through it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.tool_schema_oracle import EXPECTED, FIXTURE, main


def test_python_tool_schema_matches_the_committed_golden(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main([]) == 0
    assert "parity passed" in capsys.readouterr().out


def test_the_golden_covers_every_declared_scenario() -> None:
    fixture = json.loads(Path(FIXTURE).read_text(encoding="utf-8"))
    expected = json.loads(Path(EXPECTED).read_text(encoding="utf-8"))
    assert {scenario["id"] for scenario in fixture["scenarios"]} == set(expected["scenarios"])
    assert fixture["schema_version"] == expected["schema_version"]


def test_every_delegate_op_receives_a_host_owned_origin_ref() -> None:
    expected = json.loads(Path(EXPECTED).read_text(encoding="utf-8"))
    scenario = expected["scenarios"]["one-executor"]
    delegates = [
        schema
        for schema in scenario["schemas"]
        if scenario["bindings"].get(schema["function"]["name"], {}).get("kind") == "delegate"
    ]
    assert delegates, "the scenario must compile at least one delegate op"
    for schema in delegates:
        parameters = schema["function"]["parameters"]
        assert "origin_ref" in parameters["properties"]
        assert "origin_ref" in parameters["required"]


def test_wire_names_never_contain_a_dot_and_stay_within_the_provider_bound() -> None:
    expected = json.loads(Path(EXPECTED).read_text(encoding="utf-8"))
    for scenario in expected["scenarios"].values():
        for name in scenario["binding_order"]:
            assert "." not in name, name
            assert len(name) <= 64, name
        # The logical name keeps the dotted identity the binding table restores.
        for name, binding in scenario["bindings"].items():
            if binding["kind"] == "delegate":
                assert binding["logical_name"] == name.replace("__", ".", 1)
