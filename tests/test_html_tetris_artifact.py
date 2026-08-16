from __future__ import annotations

from pathlib import Path

import pytest

from nova_audio_agent.evals.html_tetris_artifact import (
    HTML_TETRIS_TASK_CONTRACT,
    check_html_tetris_artifact,
    initialize_html_tetris_workspace,
)

pytestmark = pytest.mark.real_time


GAME_JS = r"""
(function (root, factory) {
  const api = factory();
  root.NovaTetris = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  function createGame(seed) {
    void seed;
    const state = {
      board: [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [1, 0, 1, 1],
      ],
      activePiece: { kind: "I", x: 1, y: 0, serial: 0 },
      nextPiece: { kind: "O" },
      level: 1,
      dropIntervalMs: 1000,
      score: 0,
      gameOver: false,
    };

    function snapshot() {
      return JSON.parse(JSON.stringify(state));
    }

    function tick() {
      if (state.activePiece.y < state.board.length - 1) {
        state.activePiece.y += 1;
        return;
      }
      state.board[state.activePiece.y][state.activePiece.x] = 1;
      if (state.board[state.board.length - 1].every(Boolean)) {
        state.board.pop();
        state.board.unshift([0, 0, 0, 0]);
        state.score += 100;
      }
      state.activePiece = {
        kind: state.nextPiece.kind,
        x: 1,
        y: 0,
        serial: state.activePiece.serial + 1,
      };
      state.nextPiece = { kind: "T" };
    }

    function setLevel(level) {
      if (!Number.isInteger(level) || level < 1 || level > 10) throw new RangeError("level");
      state.level = level;
      state.dropIntervalMs = 1100 - level * 100;
    }

    return { snapshot, tick, setLevel };
  }

  return { createGame };
});
"""

INDEX_HTML = """<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><link rel="stylesheet" href="style.css"><title>Nova Tetris</title></head>
<body><main><canvas id="board"></canvas><div id="next-piece"></div><input id="level" type="range" min="1" max="10"><button id="restart">Restart</button></main><script src="game.js"></script><script src="app.js"></script></body>
</html>
"""

APP_JS = r"""
const game = NovaTetris.createGame(0);
const level = document.querySelector("#level");
level.addEventListener("input", () => game.setLevel(Number(level.value)));
document.querySelector("#restart").addEventListener("click", () => location.reload());
document.addEventListener("keydown", (event) => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(event.code)) {
    event.preventDefault();
    game.tick();
  }
});
function render() {
  const state = game.snapshot();
  document.querySelector("#next-piece").textContent = state.nextPiece.kind;
  window.setTimeout(render, state.dropIntervalMs);
}
render();
"""

SMOKE_JS = r"""
const assert = require("node:assert/strict");
const { createGame } = require("./game.js");
const game = createGame(0);
const before = game.snapshot();
game.tick();
assert.equal(game.snapshot().activePiece.y, before.activePiece.y + 1);
for (let index = 0; index < 3; index += 1) game.tick();
const locked = game.snapshot();
assert.equal(locked.activePiece.serial, 1);
assert.equal(locked.score, 100);
game.setLevel(1);
const slow = game.snapshot().dropIntervalMs;
game.setLevel(10);
const fast = game.snapshot().dropIntervalMs;
assert.ok(fast < slow);
assert.equal(game.snapshot().nextPiece.kind, "T");
console.log('NOVA_HTML_TETRIS_RESULT={"core":true,"level":true,"next":true}');
"""


def _reference_game(root: Path, mutation: str | None = None) -> None:
    index_html = INDEX_HTML
    smoke_js = SMOKE_JS
    if mutation == "remote_script":
        index_html = index_html.replace(
            '<script src="game.js"></script>',
            '<script src="https://example.invalid/game.js"></script>',
        )
    elif mutation == "smoke_nonzero":
        smoke_js += "\nprocess.exit(1);\n"
    elif mutation == "level_false":
        smoke_js = smoke_js.replace('"level":true', '"level":false')
    elif mutation == "next_false":
        smoke_js = smoke_js.replace('"next":true', '"next":false')

    files = {
        "index.html": index_html,
        "game.js": GAME_JS,
        "app.js": APP_JS,
        "style.css": "body { background: #10121a; color: #f3f3f3; }\n",
        "smoke.js": smoke_js,
    }
    for name, content in files.items():
        (root / name).write_text(content, encoding="utf-8")

    if mutation == "secret_file":
        (root / "credentials.txt").write_text(
            "OPENAI_API_KEY=" + "".join(("s", "k-secret-sentinel-value")),
            encoding="utf-8",
        )
    elif mutation == "binary_file":
        (root / "capture.bin").write_bytes(b"\x00\x01\x02")


def _gates(report) -> dict[str, bool]:
    return {gate.name: gate.passed for gate in report.gates}


def test_contract_names_entry_smoke_and_steered_features() -> None:
    for requirement in (
        "index.html",
        "node smoke.js",
        "一到十级",
        "立即生效",
        "下一个方块",
        "不得访问网络",
        "open index.html",
    ):
        assert requirement in HTML_TETRIS_TASK_CONTRACT


def test_contract_pins_the_exact_smoke_result_schema() -> None:
    assert (
        'NOVA_HTML_TETRIS_RESULT={"core":true,"level":true,"next":true}'
        in HTML_TETRIS_TASK_CONTRACT
    )
    assert "只能包含 core、level、next 三个布尔字段" in HTML_TETRIS_TASK_CONTRACT


def test_initializer_creates_only_contract_and_git_metadata(tmp_path: Path) -> None:
    workspace = initialize_html_tetris_workspace(tmp_path / "demo")

    assert {path.name for path in workspace.iterdir()} == {".git", "TASK_CONTRACT.md"}
    assert (workspace / "TASK_CONTRACT.md").read_text(encoding="utf-8") == (
        HTML_TETRIS_TASK_CONTRACT
    )


def test_initializer_refuses_nonempty_directory_without_modifying_it(tmp_path: Path) -> None:
    occupied = tmp_path / "occupied"
    occupied.mkdir()
    kept = occupied / "keep.txt"
    kept.write_text("user data", encoding="utf-8")

    with pytest.raises(ValueError, match="empty"):
        initialize_html_tetris_workspace(occupied)

    assert kept.read_text(encoding="utf-8") == "user data"


def test_reference_html_game_passes_all_gates(tmp_path: Path) -> None:
    workspace = initialize_html_tetris_workspace(tmp_path / "game")
    _reference_game(workspace)

    report = check_html_tetris_artifact(workspace)

    assert report.passed is True
    assert _gates(report) == {
        "browser_entry": True,
        "core_behavior": True,
        "steered_features": True,
        "workspace_hygiene": True,
    }


@pytest.mark.parametrize(
    ("mutation", "failed_gate", "finding"),
    [
        ("remote_script", "browser_entry", "remote_reference"),
        ("smoke_nonzero", "core_behavior", "smoke_failed"),
        ("level_false", "steered_features", "level_failed"),
        ("next_false", "steered_features", "next_failed"),
        ("secret_file", "workspace_hygiene", "secret_material"),
        ("binary_file", "workspace_hygiene", "binary_file"),
    ],
)
def test_mutations_turn_their_gate_red(
    tmp_path: Path,
    mutation: str,
    failed_gate: str,
    finding: str,
) -> None:
    workspace = initialize_html_tetris_workspace(tmp_path / mutation)
    _reference_game(workspace, mutation=mutation)

    report = check_html_tetris_artifact(workspace)

    gate = next(gate for gate in report.gates if gate.name == failed_gate)
    assert gate.passed is False
    assert finding in gate.findings
    assert report.passed is False
