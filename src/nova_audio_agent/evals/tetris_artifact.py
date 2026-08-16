"""Deterministic Python-standard-library gates for the contracted Tetris artifact."""

from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

TASK_CONTRACT = """# Contracted Tetris Task

只使用 Python 3.11+ 标准库；不得下载或新增依赖，不得依赖网络服务。

必须提供：

- `python3 -m tetris_game --smoke` 作为无交互启动检查；
- `tetris_game.engine.create_engine(seed=0)`；
- engine 的 `snapshot()`、`tick()`、`set_level(level)`；
- snapshot 至少包含 `board`、`active_piece`、`level`、`drop_interval_ms`、`game_over`；
- tick 能让活动方块下落，并在碰撞后锁入 board、生成下一块；
- level 只接受整数 1 到 10；运行中切到更高 level 后，下一次 snapshot 立即显示更短的
  `drop_interval_ms`，不得重启或改写源码。

提交前必须实际运行以下导入检查；顶层 `tetris_game.py` 文件不满足包接口：

```bash
python3 -c 'from tetris_game.engine import create_engine; create_engine(seed=0)'
```

游戏逻辑必须与渲染充分分离，所有生成文件与命令必须留在本工作区内。
"""

_NETWORK_BLOCK_PREAMBLE = r"""
import socket

class BlockedSocket:
    def __init__(self, *args, **kwargs):
        raise OSError("network disabled by artifact checker")

socket.socket = BlockedSocket
socket.create_connection = BlockedSocket
"""

_CHECK_SCRIPT = (
    _NETWORK_BLOCK_PREAMBLE
    + r"""
import json
import sys

workspace = sys.argv[1]
sys.path.insert(0, workspace)

result = {"core": False, "speed": False, "detail": []}
try:
    from tetris_game.engine import create_engine
    engine = create_engine(seed=0)
    before = engine.snapshot()
    required = {"board", "active_piece", "level", "drop_interval_ms", "game_over"}
    if type(before) is not dict or not required.issubset(before):
        raise AssertionError("snapshot_contract")
    if (
        type(before["board"]) not in (list, tuple)
        or not before["board"]
        or any(type(row) not in (list, tuple) for row in before["board"])
    ):
        raise AssertionError("board_shape")
    first_piece = before["active_piece"]
    engine.tick()
    moved = engine.snapshot()
    if moved["active_piece"] == first_piece:
        raise AssertionError("tick_did_not_advance")
    initial_filled = sum(bool(cell) for row in before["board"] for cell in row)
    locked = False
    for _ in range(max(32, len(before["board"]) * 8)):
        prior = engine.snapshot()
        engine.tick()
        current = engine.snapshot()
        filled = sum(bool(cell) for row in current["board"] for cell in row)
        if filled > initial_filled and current["active_piece"] != prior["active_piece"]:
            locked = True
            break
    if not locked:
        raise AssertionError("piece_never_locked")
    result["core"] = True
except Exception as failure:
    result["detail"].append("core:" + type(failure).__name__ + ":" + str(failure)[:80])

try:
    from tetris_game.engine import create_engine
    engine = create_engine(seed=0)
    engine.set_level(1)
    slow = engine.snapshot()
    engine.set_level(10)
    fast = engine.snapshot()
    if fast["level"] != 10 or not fast["drop_interval_ms"] < slow["drop_interval_ms"]:
        raise AssertionError("speed_not_immediate_or_faster")
    for invalid in (0, 11, True, 1.5, "2"):
        try:
            engine.set_level(invalid)
        except (TypeError, ValueError):
            pass
        else:
            raise AssertionError("invalid_level_accepted")
    result["speed"] = True
except Exception as failure:
    result["detail"].append("speed:" + type(failure).__name__ + ":" + str(failure)[:80])

print("NOVA_TETRIS_RESULT=" + json.dumps(result, separators=(",", ":"), sort_keys=True))
"""
)

_SECRET_PATTERNS = (
    re.compile(rb"(?i)OPENAI_API_KEY\s*="),
    re.compile(rb"(?i)(?:sk|rk|pk)-[A-Za-z0-9_./+=-]{8,}"),
    re.compile(rb"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
)
_BINARY_SUFFIXES = frozenset({".bin", ".exe", ".dll", ".dylib", ".so", ".pyc", ".class"})


@dataclass(frozen=True, slots=True)
class ArtifactGate:
    name: str
    passed: bool
    findings: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class TetrisArtifactReport:
    gates: tuple[ArtifactGate, ...]

    @property
    def passed(self) -> bool:
        return all(gate.passed for gate in self.gates)


@contextmanager
def create_contracted_workspace() -> Iterator[Path]:
    """Create a disposable Git repo with only the visible contract committed."""
    with tempfile.TemporaryDirectory(prefix="nova-m1-tetris-") as directory:
        workspace = Path(directory)
        (workspace / "TASK_CONTRACT.md").write_text(TASK_CONTRACT, encoding="utf-8")
        commands = (
            ("git", "init", "-q"),
            ("git", "add", "TASK_CONTRACT.md"),
            (
                "git",
                "-c",
                "user.name=Nova M1 Eval",
                "-c",
                "user.email=nova-m1@example.invalid",
                "commit",
                "-q",
                "-m",
                "Initialize contracted Tetris workspace",
            ),
        )
        for command in commands:
            subprocess.run(
                command,
                cwd=workspace,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=True,
                timeout=10,
            )
        yield workspace


def check_tetris_artifact(workspace: Path) -> TetrisArtifactReport:
    workspace = workspace.resolve(strict=True)
    before_hashes = _source_hashes(workspace)
    build = _build_and_start(workspace)
    behavior = _behavior_checks(workspace)
    after_hashes = _source_hashes(workspace)
    source_changed = before_hashes != after_hashes
    core_findings = tuple(behavior["detail"]) if not behavior["core"] else ()
    speed_findings = tuple(behavior["detail"]) if not behavior["speed"] else ()
    if source_changed:
        speed_findings = (*speed_findings, "source_changed_during_speed_check")
    hygiene_findings = _workspace_hygiene(workspace)
    return TetrisArtifactReport(
        gates=(
            ArtifactGate("build_and_start", build[0], build[1]),
            ArtifactGate("core_tetris_behavior", bool(behavior["core"]), core_findings),
            ArtifactGate(
                "steered_speed_control",
                bool(behavior["speed"]) and not source_changed,
                speed_findings,
            ),
            ArtifactGate("workspace_hygiene", not hygiene_findings, hygiene_findings),
        )
    )


def _build_and_start(workspace: Path) -> tuple[bool, tuple[str, ...]]:
    result = _run_python(
        workspace,
        _NETWORK_BLOCK_PREAMBLE + "import runpy,sys;sys.path.insert(0,sys.argv[1]);"
        "sys.argv=['tetris_game','--smoke'];runpy.run_module('tetris_game',run_name='__main__')",
    )
    if result is None:
        return False, ("timeout_or_invalid_output",)
    return (result.returncode == 0, () if result.returncode == 0 else ("smoke_failed",))


def _behavior_checks(workspace: Path) -> dict[str, object]:
    result = _run_python(workspace, _CHECK_SCRIPT)
    if result is None or result.returncode != 0:
        return {"core": False, "speed": False, "detail": ["checker_failed"]}
    for line in reversed(result.stdout.decode("utf-8", errors="replace").splitlines()):
        if not line.startswith("NOVA_TETRIS_RESULT="):
            continue
        try:
            value = json.loads(line.removeprefix("NOVA_TETRIS_RESULT="))
        except (ValueError, TypeError):
            break
        if (
            type(value) is dict
            and type(value.get("core")) is bool
            and type(value.get("speed")) is bool
            and type(value.get("detail")) is list
            and all(type(item) is str for item in value["detail"])
        ):
            return value
        break
    return {"core": False, "speed": False, "detail": ["malformed_checker_output"]}


def _run_python(workspace: Path, script: str) -> subprocess.CompletedProcess[bytes] | None:
    env = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONIOENCODING": "utf-8",
        "NO_PROXY": "*",
        "no_proxy": "*",
    }
    try:
        return subprocess.run(
            [sys.executable, "-I", "-B", "-c", script, str(workspace)],
            cwd=workspace,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def _source_hashes(workspace: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for path in sorted(workspace.rglob("*.py")):
        if ".git" in path.parts:
            continue
        try:
            result[path.relative_to(workspace).as_posix()] = hashlib.sha256(
                path.read_bytes()
            ).hexdigest()
        except OSError:
            result[path.relative_to(workspace).as_posix()] = "unreadable"
    return result


def _workspace_hygiene(workspace: Path) -> tuple[str, ...]:
    findings: set[str] = set()
    for path in workspace.rglob("*"):
        relative = path.relative_to(workspace)
        if relative.parts and relative.parts[0] == ".git":
            continue
        if path.is_symlink():
            try:
                path.resolve(strict=True).relative_to(workspace)
            except (OSError, ValueError):
                findings.add("external_checkout")
            continue
        if not path.is_file():
            continue
        lowered = relative.as_posix().lower()
        if "__pycache__" in relative.parts and path.suffix.lower() == ".pyc":
            continue
        if "rollout" in lowered or "/sessions/" in f"/{lowered}":
            findings.add("codex_rollout")
        if "trust" in lowered and path.suffix == ".toml":
            findings.add("project_trust")
        try:
            raw = path.read_bytes()
        except OSError:
            findings.add("unreadable_file")
            continue
        if any(pattern.search(raw) for pattern in _SECRET_PATTERNS):
            findings.add("secret_material")
        if path.suffix.lower() in _BINARY_SUFFIXES or b"\x00" in raw[:4096]:
            findings.add("unexplained_binary")
    findings.update(_dependency_findings(workspace))
    return tuple(sorted(findings))


def _dependency_findings(workspace: Path) -> set[str]:
    findings: set[str] = set()
    local_roots = {path.stem for path in workspace.glob("*.py")}
    local_roots.update(
        path.name
        for path in workspace.iterdir()
        if path.is_dir() and any(child.suffix == ".py" for child in path.glob("*.py"))
    )
    for path in workspace.rglob("*.py"):
        if ".git" in path.parts:
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, SyntaxError):
            findings.add("invalid_python_source")
            continue
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.partition(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                imported.add(node.module.partition(".")[0])
        if any(
            name not in sys.stdlib_module_names and name not in local_roots for name in imported
        ):
            findings.add("third_party_dependency")
    return findings
