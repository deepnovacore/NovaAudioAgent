"""Gate the Python side of model-gateway request-body parity.

The client library is not the contract; the wire body is, and it is model-visible.
Python builds it through the `openai` SDK and Node through `fetch`, so both are pinned
to the same committed bytes.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.gateway_request_oracle import EXPECTED, FIXTURE, main


def test_python_gateway_requests_match_the_committed_golden(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main([]) == 0
    assert "parity passed" in capsys.readouterr().out


def test_the_golden_covers_every_declared_scenario() -> None:
    fixture = json.loads(Path(FIXTURE).read_text(encoding="utf-8"))
    expected = json.loads(Path(EXPECTED).read_text(encoding="utf-8"))
    assert {scenario["id"] for scenario in fixture["scenarios"]} == set(expected["requests"])
    assert fixture["schema_version"] == expected["schema_version"]


def test_every_request_carries_a_system_and_a_user_message_in_that_order() -> None:
    expected = json.loads(Path(EXPECTED).read_text(encoding="utf-8"))
    for name, body in expected["requests"].items():
        roles = [message["role"] for message in body["messages"]]
        assert roles == ["system", "user"], name


def test_tools_always_disable_parallel_tool_calls() -> None:
    expected = json.loads(Path(EXPECTED).read_text(encoding="utf-8"))
    for name, body in expected["requests"].items():
        if "tools" in body:
            assert body["parallel_tool_calls"] is False, name
        else:
            assert "parallel_tool_calls" not in body, name


def test_each_image_is_preceded_by_its_own_ref_label() -> None:
    # Emission order follows the byte budget, so the ref binding must be explicit.
    expected = json.loads(Path(EXPECTED).read_text(encoding="utf-8"))
    content = expected["requests"]["stream-with-images"]["messages"][1]["content"]
    labels = [part["text"] for part in content if part["type"] == "text"]
    images = [part for part in content if part["type"] == "image_url"]
    assert labels[1:] == ["[media:1]", "[media:2]"]
    assert len(images) == 2
    for image in images:
        assert image["image_url"]["url"].startswith("data:image/")


def test_a_json_schema_never_travels_to_the_provider() -> None:
    expected = json.loads(Path(EXPECTED).read_text(encoding="utf-8"))
    body = expected["requests"]["complete-json-object"]
    assert body["response_format"] == {"type": "json_object"}
    assert "properties" not in json.dumps(body["response_format"])
