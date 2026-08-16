"""Deterministic gates for the offline Markdown notes demo artifact."""

from __future__ import annotations

import json
import os
import re
import selectors
import signal
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path

from nova_audio_agent.clock import RealClock

MARKDOWN_NOTES_TASK_CONTRACT = """# Offline Markdown Notes Demo Contract

这是一个已有的离线 Markdown 笔记网页。请在现有 index.html、app.js、app.test.js 上加入：
1. 编辑时自动保存到浏览器本地存储；
2. 刷新页面后恢复最后一份笔记；
3. 将当前内容导出为 .md 文件；
4. 为保存、恢复和导出补充确定性测试。

不得访问网络、CDN 或安装第三方依赖。验证命令必须是 `node --test app.test.js`。
普通代码阅读和准备步骤可以写入真实进度，但不要宣称已完成；只有一个可验证增量连同测试
通过后才可报告阶段完成。最终先不要执行 `open`，由录制者决定何时展示页面。
"""

_EXPECTED_FILES = frozenset({"TASK_CONTRACT.md", "index.html", "app.js", "app.test.js"})
_REMOTE_REFERENCE = re.compile(rb"(?i)(?:https?:)?//")
_SECRET_PATTERNS = (
    re.compile(rb"(?i)(?:OPENAI|DASHSCOPE|TAVILY)_API_KEY\s*="),
    re.compile(rb"(?i)(?:sk|rk|pk)-[A-Za-z0-9_./+=-]{8,}"),
    re.compile(rb"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
)
_BINARY_SUFFIXES = frozenset({".bin", ".exe", ".dll", ".dylib", ".so", ".pyc", ".class", ".zip"})
_RESULT_PREFIX = "NOVA_MARKDOWN_NOTES_RESULT="
_RESULT_KEYS = ("autosave", "reload", "export")
_TRUE_RESULT_LINE = 'NOVA_MARKDOWN_NOTES_RESULT={"autosave":true,"reload":true,"export":true}'
_FILE_READ_LIMIT = 512 * 1024
_PROCESS_OUTPUT_LIMIT = 64 * 1024
_PROCESS_READ_CHUNK = 8 * 1024
_PROCESS_TIMEOUT = 5.0
_PROCESS_STOP_GRACE = 0.25

_INDEX_HTML = """<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Offline Markdown Notes</title></head>
<body>
  <main>
    <h1>离线 Markdown 笔记</h1>
    <label for="note-editor">笔记</label>
    <textarea id="note-editor" rows="12"># 欢迎\n\n写下你的笔记。</textarea>
    <h2>预览</h2>
    <section id="preview" aria-live="polite"></section>
  </main>
  <script src="app.js"></script>
</body>
</html>
"""

_APP_JS = r"""(function (root, factory) {
  const api = factory();
  root.NovaNotes = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function renderMarkdown(source) {
    return escapeHtml(String(source)).split("\n").map(function (line) {
      if (line.startsWith("# ")) return "<h1>" + line.slice(2) + "</h1>";
      return "<p>" + line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>") + "</p>";
    }).join("\n");
  }

  function createPageState(initialNote) {
    let note = String(initialNote);
    return {
      getNote: function () { return note; },
      setNote: function (nextNote) { note = String(nextNote); },
      preview: function () { return renderMarkdown(note); },
    };
  }

  function mount(page) {
    const editor = page.querySelector("#note-editor");
    const preview = page.querySelector("#preview");
    const state = createPageState(editor.value);
    function updatePreview() { preview.innerHTML = state.preview(); }
    editor.addEventListener("input", function () {
      state.setNote(editor.value);
      updatePreview();
    });
    updatePreview();
    return state;
  }

  if (typeof document !== "undefined") mount(document);
  return { renderMarkdown: renderMarkdown, createPageState: createPageState, mount: mount };
});
"""

_APP_TEST_JS = r"""const assert = require("node:assert/strict");
const test = require("node:test");
const { createPageState, renderMarkdown } = require("./app.js");

test("renders headings and emphasis", function () {
  assert.equal(renderMarkdown("# Title\n**important**"), "<h1>Title</h1>\n<p><strong>important</strong></p>");
});

test("keeps the edited note in page state", function () {
  const state = createPageState("first");
  state.setNote("second");
  assert.equal(state.getNote(), "second");
  assert.equal(state.preview(), "<p>second</p>");
});

console.log('NOVA_MARKDOWN_NOTES_RESULT={"autosave":false,"reload":false,"export":false}');
"""


@dataclass(frozen=True, slots=True)
class MarkdownNotesArtifactGate:
    name: str
    passed: bool
    findings: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class MarkdownNotesArtifactReport:
    gates: tuple[MarkdownNotesArtifactGate, ...]

    @property
    def passed(self) -> bool:
        return all(gate.passed for gate in self.gates)


def initialize_markdown_notes_workspace(workspace: Path) -> Path:
    """Create a fresh self-contained notes page without replacing user data."""
    target = workspace.absolute()
    if target.exists() or target.is_symlink():
        mode = os.lstat(target).st_mode
        if not stat.S_ISDIR(mode) or any(target.iterdir()):
            raise ValueError("Markdown notes workspace must be an empty directory")
    else:
        target.mkdir(parents=True)
    resolved = target.resolve(strict=True)
    for name, content in {
        "TASK_CONTRACT.md": MARKDOWN_NOTES_TASK_CONTRACT,
        "index.html": _INDEX_HTML,
        "app.js": _APP_JS,
        "app.test.js": _APP_TEST_JS,
    }.items():
        (resolved / name).write_text(content, encoding="utf-8")
    subprocess.run(
        ("git", "init", "-q", str(resolved)),
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
    )
    return resolved


def check_markdown_notes_artifact(workspace: Path) -> MarkdownNotesArtifactReport:
    """Check the completed notes artifact using only its observable outputs."""
    root = _real_workspace(workspace)
    contents, required_findings = _required_file_contents(root)
    browser_findings = _browser_entry_findings(contents, required_findings)
    hygiene_findings = _workspace_hygiene_findings(root)
    if browser_findings or hygiene_findings:
        result, test_findings = None, ("tests_failed",)
    else:
        result, test_findings = _run_tests(root)
    behavior = result or {}
    return MarkdownNotesArtifactReport(
        gates=(
            MarkdownNotesArtifactGate("browser_entry", not browser_findings, browser_findings),
            MarkdownNotesArtifactGate(
                "autosave",
                result is not None and behavior["autosave"],
                ()
                if result is not None and behavior["autosave"]
                else _behavior_findings("autosave", test_findings),
            ),
            MarkdownNotesArtifactGate(
                "reload",
                result is not None and behavior["reload"],
                ()
                if result is not None and behavior["reload"]
                else _behavior_findings("reload", test_findings),
            ),
            MarkdownNotesArtifactGate(
                "export",
                result is not None and behavior["export"],
                ()
                if result is not None and behavior["export"]
                else _behavior_findings("export", test_findings),
            ),
            MarkdownNotesArtifactGate("workspace_hygiene", not hygiene_findings, hygiene_findings),
        )
    )


def _real_workspace(workspace: Path) -> Path:
    absolute = workspace.absolute()
    try:
        mode = os.lstat(absolute).st_mode
    except OSError as exc:
        raise ValueError("Markdown notes workspace must be a real directory") from exc
    if not stat.S_ISDIR(mode):
        raise ValueError("Markdown notes workspace must be a real directory")
    return absolute.resolve(strict=True)


def _required_file_contents(root: Path) -> tuple[dict[str, bytes], tuple[str, ...]]:
    contents: dict[str, bytes] = {}
    findings: set[str] = set()
    for name in _EXPECTED_FILES:
        raw, finding = _read_regular_file_limited(root / name)
        if finding:
            findings.add(finding)
            continue
        assert raw is not None
        contents[name] = raw
    return contents, tuple(sorted(findings))


def _browser_entry_findings(
    contents: dict[str, bytes], required_findings: tuple[str, ...]
) -> tuple[str, ...]:
    findings = set(required_findings)
    index = contents.get("index.html", b"")
    if not index or b"app.js" not in index:
        findings.add("unexpected_file")
    if any(_REMOTE_REFERENCE.search(raw) for raw in contents.values()):
        findings.add("remote_reference")
    return tuple(sorted(findings))


def _run_tests(root: Path) -> tuple[dict[str, bool] | None, tuple[str, ...]]:
    path = root / "app.test.js"
    if not _is_regular_file(path):
        return None, ("tests_failed",)
    env = {"PATH": os.environ.get("PATH", ""), "NO_PROXY": "*", "no_proxy": "*"}
    stdout, returncode, findings = _run_bounded_process(
        ("node", "--test", "app.test.js"), root, env
    )
    if findings:
        return None, findings
    if returncode != 0 or stdout is None:
        return None, ("tests_failed",)
    lines = [
        line
        for line in stdout.decode("utf-8", errors="replace").splitlines()
        if line.startswith(_RESULT_PREFIX)
    ]
    if len(lines) != 1:
        return None, ("tests_failed",)
    try:
        payload = json.loads(lines[0].removeprefix(_RESULT_PREFIX))
    except (TypeError, ValueError):
        return None, ("tests_failed",)
    if (
        type(payload) is not dict
        or tuple(payload) != _RESULT_KEYS
        or any(type(payload[key]) is not bool for key in _RESULT_KEYS)
    ):
        return None, ("tests_failed",)
    if all(payload.values()) and lines[0] != _TRUE_RESULT_LINE:
        return None, ("tests_failed",)
    return payload, ()


def _behavior_findings(name: str, test_findings: tuple[str, ...]) -> tuple[str, ...]:
    return test_findings or (f"{name}_failed",)


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
        raw, finding = _read_regular_file_limited(path)
        if finding:
            findings.add(finding)
            continue
        assert raw is not None
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


def _read_regular_file_limited(path: Path) -> tuple[bytes | None, str | None]:
    """Read one ordinary file without allowing it to control evaluator memory use."""
    flags = os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError:
        return None, "unexpected_file"
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            return None, "unexpected_file"
        if metadata.st_size > _FILE_READ_LIMIT:
            return None, "oversized_file"
        raw = os.read(descriptor, _FILE_READ_LIMIT + 1)
    except OSError:
        return None, "unexpected_file"
    finally:
        os.close(descriptor)
    if len(raw) > _FILE_READ_LIMIT:
        return None, "oversized_file"
    return raw, None


def _run_bounded_process(
    command: tuple[str, ...], root: Path, env: dict[str, str]
) -> tuple[bytes | None, int | None, tuple[str, ...]]:
    """Run a fixed command while retaining at most a small aggregate output budget."""
    clock = RealClock()
    try:
        process = subprocess.Popen(
            command,
            cwd=root,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except OSError:
        return None, None, ("tests_failed",)
    assert process.stdout is not None
    assert process.stderr is not None
    stdout = bytearray()
    output_size = 0
    deadline = clock.now() + _PROCESS_TIMEOUT
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        while selector.get_map():
            remaining = deadline - clock.now()
            if remaining <= 0:
                _stop_process(process)
                return None, None, ("tests_failed",)
            for key, _ in selector.select(remaining):
                chunk = os.read(
                    key.fileobj.fileno(),
                    min(_PROCESS_READ_CHUNK, _PROCESS_OUTPUT_LIMIT - output_size + 1),
                )
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                output_size += len(chunk)
                if output_size > _PROCESS_OUTPUT_LIMIT:
                    _stop_process(process)
                    return None, None, ("tests_output_overflow",)
                if key.data == "stdout":
                    stdout.extend(chunk)
    try:
        returncode = process.wait(timeout=max(0, deadline - clock.now()))
    except subprocess.TimeoutExpired:
        _stop_process(process)
        return None, None, ("tests_failed",)
    return bytes(stdout), returncode, ()


def _stop_process(process: subprocess.Popen[bytes]) -> None:
    _signal_process_group(process, signal.SIGTERM)
    try:
        process.wait(timeout=_PROCESS_STOP_GRACE)
    except subprocess.TimeoutExpired:
        pass
    _signal_process_group(process, signal.SIGKILL)
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        pass
    for stream in (process.stdout, process.stderr):
        if stream is not None:
            stream.close()


def _signal_process_group(process: subprocess.Popen[bytes], signal_number: int) -> None:
    """Signal only the session created for this evaluator child process."""
    try:
        os.killpg(process.pid, signal_number)
    except ProcessLookupError:
        pass
