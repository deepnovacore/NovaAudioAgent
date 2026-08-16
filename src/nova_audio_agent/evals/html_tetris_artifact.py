"""Deterministic gates for the self-contained HTML Tetris demo artifact."""

from __future__ import annotations

import json
import os
import re
import stat
import subprocess
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

HTML_TETRIS_TASK_CONTRACT = """# HTML Tetris Demo Contract

创建一个无需安装、浏览器直接打开的复古街机风俄罗斯方块。
必须提供 index.html、game.js、app.js、style.css 和 smoke.js。所有页面资源必须是工作区
内的相对文件；不得访问网络、CDN 或下载依赖。game.js 同时支持浏览器全局
NovaTetris 和 Node.js module.exports。node smoke.js 必须零状态退出并输出这一行：
NOVA_HTML_TETRIS_RESULT={"core":true,"level":true,"next":true}。
等号后的 JSON 只能包含 core、level、next 三个布尔字段，不得增加嵌套详情或其他字段。

游戏支持键盘左右移动、旋转、软降、硬降、消行、计分、game over 和重新开始。
同一 turn 的 steering 会加入一到十级速度控制（运行中切换立即生效）和下一个方块预览。
smoke.js 必须验证核心下落/锁定/消行、level 1 与 level 10 的即时速度变化以及 next piece。

完成前必须实际运行 node smoke.js。全部验证通过后执行 open index.html；打开失败必须
如实报告。所有生成文件只能位于本工作区。
"""

_EXPECTED_FILES = frozenset(
    {"TASK_CONTRACT.md", "index.html", "game.js", "app.js", "style.css", "smoke.js"}
)
_PAGE_FILES = ("index.html", "game.js", "app.js", "style.css")
_REMOTE_REFERENCE = re.compile(rb"(?i)(?:https?:)?//")
_SECRET_PATTERNS = (
    re.compile(rb"(?i)(?:OPENAI|DASHSCOPE|TAVILY)_API_KEY\s*="),
    re.compile(rb"(?i)(?:sk|rk|pk)-[A-Za-z0-9_./+=-]{8,}"),
    re.compile(rb"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
)
_BINARY_SUFFIXES = frozenset({".bin", ".exe", ".dll", ".dylib", ".so", ".pyc", ".class", ".zip"})
_SMOKE_PREFIX = "NOVA_HTML_TETRIS_RESULT="


@dataclass(frozen=True, slots=True)
class HtmlArtifactGate:
    name: str
    passed: bool
    findings: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class HtmlTetrisArtifactReport:
    gates: tuple[HtmlArtifactGate, ...]

    @property
    def passed(self) -> bool:
        return all(gate.passed for gate in self.gates)


def initialize_html_tetris_workspace(workspace: Path) -> Path:
    """Initialize a new or empty real directory without deleting existing data."""
    target = workspace.absolute()
    if target.exists() or target.is_symlink():
        mode = os.lstat(target).st_mode
        if not stat.S_ISDIR(mode) or any(target.iterdir()):
            raise ValueError("HTML Tetris workspace must be an empty directory")
    else:
        target.mkdir(parents=True)
    resolved = target.resolve(strict=True)
    (resolved / "TASK_CONTRACT.md").write_text(
        HTML_TETRIS_TASK_CONTRACT,
        encoding="utf-8",
    )
    subprocess.run(
        ("git", "init", "-q", str(resolved)),
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
    )
    return resolved


@contextmanager
def create_html_tetris_workspace() -> Iterator[Path]:
    """Yield a disposable workspace initialized with the visible contract."""
    with tempfile.TemporaryDirectory(prefix="nova-html-tetris-") as directory:
        yield initialize_html_tetris_workspace(Path(directory))


def check_html_tetris_artifact(workspace: Path) -> HtmlTetrisArtifactReport:
    """Check browser entry, behavior, steered features, and workspace hygiene."""
    root = _real_workspace(workspace)
    browser_findings = _browser_entry_findings(root)
    smoke, smoke_findings = _run_smoke(root)
    core_findings = smoke_findings
    if smoke is not None and not smoke["core"]:
        core_findings = ("smoke_failed",)
    steer_findings: list[str] = []
    if smoke is None:
        steer_findings.extend(smoke_findings)
    else:
        if not smoke["level"]:
            steer_findings.append("level_failed")
        if not smoke["next"]:
            steer_findings.append("next_failed")
    hygiene_findings = _workspace_hygiene_findings(root)
    return HtmlTetrisArtifactReport(
        gates=(
            HtmlArtifactGate("browser_entry", not browser_findings, browser_findings),
            HtmlArtifactGate("core_behavior", not core_findings, core_findings),
            HtmlArtifactGate(
                "steered_features",
                not steer_findings,
                tuple(steer_findings),
            ),
            HtmlArtifactGate("workspace_hygiene", not hygiene_findings, hygiene_findings),
        )
    )


def _real_workspace(workspace: Path) -> Path:
    absolute = workspace.absolute()
    mode = os.lstat(absolute).st_mode
    if not stat.S_ISDIR(mode):
        raise ValueError("HTML Tetris workspace must be a real directory")
    return absolute.resolve(strict=True)


def _browser_entry_findings(root: Path) -> tuple[str, ...]:
    findings: set[str] = set()
    contents: dict[str, bytes] = {}
    for name in _PAGE_FILES:
        path = root / name
        if not _is_regular_file(path):
            findings.add("unexpected_file")
            continue
        try:
            contents[name] = path.read_bytes()
        except OSError:
            findings.add("unexpected_file")
    index = contents.get("index.html", b"")
    if not index or len(index) > 512 * 1024:
        findings.add("unexpected_file")
    for name in (b"style.css", b"game.js", b"app.js"):
        if name not in index:
            findings.add("unexpected_file")
    if any(_REMOTE_REFERENCE.search(raw) for raw in contents.values()):
        findings.add("remote_reference")
    return tuple(sorted(findings))


def _run_smoke(root: Path) -> tuple[dict[str, bool] | None, tuple[str, ...]]:
    smoke_path = root / "smoke.js"
    if not _is_regular_file(smoke_path):
        return None, ("smoke_failed",)
    env = {"PATH": os.environ.get("PATH", ""), "NO_PROXY": "*", "no_proxy": "*"}
    try:
        result = subprocess.run(
            ("node", "smoke.js"),
            cwd=root,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=5,
            check=False,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except (OSError, subprocess.SubprocessError):
        return None, ("smoke_failed",)
    if result.returncode != 0:
        return None, ("smoke_failed",)
    lines = [line for line in result.stdout.splitlines() if line.startswith(_SMOKE_PREFIX)]
    if len(lines) != 1:
        return None, ("smoke_failed",)
    try:
        payload = json.loads(lines[0].removeprefix(_SMOKE_PREFIX))
    except (TypeError, ValueError):
        return None, ("smoke_failed",)
    if (
        type(payload) is not dict
        or set(payload) != {"core", "level", "next"}
        or any(type(payload[key]) is not bool for key in ("core", "level", "next"))
    ):
        return None, ("smoke_failed",)
    return payload, ()


def _workspace_hygiene_findings(root: Path) -> tuple[str, ...]:
    findings: set[str] = set()
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if relative.parts and relative.parts[0] == ".git":
            continue
        if relative.as_posix() not in _EXPECTED_FILES:
            findings.add("unexpected_file")
        if not _is_regular_file(path):
            if path.is_symlink() or not path.is_dir():
                findings.add("unexpected_file")
            continue
        try:
            raw = path.read_bytes()
        except OSError:
            findings.add("unexpected_file")
            continue
        if any(pattern.search(raw) for pattern in _SECRET_PATTERNS):
            findings.add("secret_material")
        if path.suffix.lower() in _BINARY_SUFFIXES or b"\x00" in raw[:4096]:
            findings.add("binary_file")
    return tuple(sorted(findings))


def _is_regular_file(path: Path) -> bool:
    try:
        return stat.S_ISREG(os.lstat(path).st_mode)
    except OSError:
        return False
