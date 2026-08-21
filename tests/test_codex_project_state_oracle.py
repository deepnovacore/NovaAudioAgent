from __future__ import annotations

import base64
import json

import pytest

from nova_audio_agent.executors import codex_projects
from scripts.codex_project_state_oracle import FIXTURE, build, main


def test_committed_project_state_bytes_are_python_exporter_owned(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main(["check"]) == 0
    assert "project-state v1 bytes match" in capsys.readouterr().out


def test_both_fixture_states_are_accepted_by_the_python_v1_decoder() -> None:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert fixture == build()
    for key in ("input_utf8_base64", "recovered_utf8_base64"):
        value = json.loads(base64.b64decode(fixture[key]))
        state = codex_projects._decode_state(value)
        assert state.active_workspace_id == "workspace-0001"
