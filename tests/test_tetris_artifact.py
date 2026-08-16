from __future__ import annotations

from pathlib import Path

import pytest

from nova_audio_agent.evals.tetris_artifact import (
    TASK_CONTRACT,
    check_tetris_artifact,
    create_contracted_workspace,
)

pytestmark = pytest.mark.real_time


ENGINE = """
class Engine:
    def __init__(self, seed=0):
        self.board = [[0 for _ in range(4)] for _ in range(6)]
        self.active = {"kind": "I", "x": 1, "y": 0, "serial": 0}
        self.level = 1
        self.drop_interval_ms = 1000

    def snapshot(self):
        return {
            "board": [row[:] for row in self.board],
            "active_piece": dict(self.active),
            "level": self.level,
            "drop_interval_ms": self.drop_interval_ms,
            "game_over": False,
        }

    def tick(self):
        if self.active["y"] < len(self.board) - 1:
            self.active["y"] += 1
        else:
            self.board[self.active["y"]][self.active["x"]] = 1
            self.active = {"kind": "I", "x": 1, "y": 0, "serial": self.active["serial"] + 1}

    def set_level(self, level):
        if type(level) is not int or not 1 <= level <= 10:
            raise ValueError("level")
        self.level = level
        self.drop_interval_ms = 1100 - level * 100

def create_engine(seed=0):
    return Engine(seed)
"""

MAIN = """
import argparse
from .engine import create_engine

parser = argparse.ArgumentParser()
parser.add_argument("--smoke", action="store_true")
args = parser.parse_args()
if args.smoke:
    engine = create_engine(seed=0)
    engine.tick()
    print("smoke-ok")
"""


def _game(root: Path, *, mutation: str | None = None) -> None:
    package = root / "tetris_game"
    package.mkdir()
    (package / "__init__.py").write_text("")
    engine = ENGINE
    if mutation == "noop_setter":
        engine = engine.replace(
            "        self.level = level\n        self.drop_interval_ms = 1100 - level * 100",
            "        return None",
        )
    elif mutation == "reverse_speed":
        engine = engine.replace("1100 - level * 100", "100 + level * 100")
    elif mutation == "delayed_speed":
        engine = engine.replace(
            "        self.level = level\n        self.drop_interval_ms = 1100 - level * 100",
            "        self.pending_level = level",
        )
    elif mutation == "never_lock":
        engine = engine.replace(
            '        else:\n            self.board[self.active["y"]][self.active["x"]] = 1\n            self.active = {"kind": "I", "x": 1, "y": 0, "serial": self.active["serial"] + 1}',
            "        else:\n            return None",
        )
    elif mutation == "tuple_snapshot":
        engine = engine.replace(
            '"board": [row[:] for row in self.board],',
            '"board": tuple(tuple(row) for row in self.board),',
        )
    (package / "engine.py").write_text(engine)
    (package / "__main__.py").write_text(MAIN)


def _gates(report) -> dict[str, bool]:
    return {gate.name: gate.passed for gate in report.gates}


def test_contracted_workspace_contains_only_committed_contract() -> None:
    with create_contracted_workspace() as workspace:
        assert (workspace / "TASK_CONTRACT.md").read_text() == TASK_CONTRACT
        assert not (workspace / "tetris_game").exists()
        assert (workspace / ".git").is_dir()


def test_contract_exposes_every_required_engine_interface_and_verification_import() -> None:
    for requirement in (
        "tetris_game.engine.create_engine(seed=0)",
        "set_level(level)",
        "drop_interval_ms",
        "from tetris_game.engine import create_engine",
    ):
        assert requirement in TASK_CONTRACT


def test_reference_standard_library_game_passes_all_hard_gates(tmp_path: Path) -> None:
    _game(tmp_path)

    report = check_tetris_artifact(tmp_path)

    assert report.passed is True
    assert _gates(report) == {
        "build_and_start": True,
        "core_tetris_behavior": True,
        "steered_speed_control": True,
        "workspace_hygiene": True,
    }


def test_smoke_gate_blocks_network_socket_creation(tmp_path: Path) -> None:
    _game(tmp_path)
    main = tmp_path / "tetris_game" / "__main__.py"
    main.write_text("import socket\nsocket.socket()\n" + main.read_text())

    report = check_tetris_artifact(tmp_path)

    gates = _gates(report)
    assert gates["build_and_start"] is False
    assert gates["core_tetris_behavior"] is True
    assert gates["steered_speed_control"] is True
    assert gates["workspace_hygiene"] is True
    build = next(gate for gate in report.gates if gate.name == "build_and_start")
    assert build.findings == ("smoke_failed",)


@pytest.mark.parametrize(
    "mutation, failed_gate",
    [
        ("noop_setter", "steered_speed_control"),
        ("reverse_speed", "steered_speed_control"),
        ("delayed_speed", "steered_speed_control"),
        ("never_lock", "core_tetris_behavior"),
    ],
)
def test_mutations_prove_each_behavior_gate_is_live(
    tmp_path: Path, mutation: str, failed_gate: str
) -> None:
    _game(tmp_path, mutation=mutation)

    report = check_tetris_artifact(tmp_path)

    assert _gates(report)[failed_gate] is False
    assert report.passed is False


def test_hygiene_rejects_secret_and_unexplained_binary(tmp_path: Path) -> None:
    _game(tmp_path)
    fake_token = "".join(("s", "k-secret-sentinel-value"))
    (tmp_path / "credentials.txt").write_text(f"OPENAI_API_KEY={fake_token}")
    (tmp_path / "blob.bin").write_bytes(b"\x00\x01\x02")

    report = check_tetris_artifact(tmp_path)

    hygiene = next(gate for gate in report.gates if gate.name == "workspace_hygiene")
    assert hygiene.passed is False
    assert set(hygiene.findings) == {"secret_material", "unexplained_binary"}


def test_hygiene_rejects_non_standard_library_import(tmp_path: Path) -> None:
    _game(tmp_path)
    engine = tmp_path / "tetris_game" / "engine.py"
    engine.write_text("import pygame\n" + engine.read_text())

    report = check_tetris_artifact(tmp_path)

    hygiene = next(gate for gate in report.gates if gate.name == "workspace_hygiene")
    assert hygiene.passed is False
    assert "third_party_dependency" in hygiene.findings


def test_hygiene_treats_python_cache_as_explainable_generated_output(tmp_path: Path) -> None:
    _game(tmp_path)
    cache = tmp_path / "tetris_game" / "__pycache__"
    cache.mkdir()
    (cache / "engine.cpython-311.pyc").write_bytes(b"\x00\x01\x02")

    report = check_tetris_artifact(tmp_path)

    assert _gates(report)["workspace_hygiene"] is True


def test_core_gate_accepts_an_immutable_board_snapshot(tmp_path: Path) -> None:
    _game(tmp_path, mutation="tuple_snapshot")

    report = check_tetris_artifact(tmp_path)

    assert report.passed is True
