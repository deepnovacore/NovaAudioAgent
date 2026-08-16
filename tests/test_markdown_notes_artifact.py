from __future__ import annotations

import os
import signal
import shutil
import threading
import time
from pathlib import Path

import pytest

import nova_audio_agent.evals.markdown_notes_artifact as markdown_notes_artifact
from nova_audio_agent.evals.markdown_notes_artifact import (
    MARKDOWN_NOTES_TASK_CONTRACT,
    check_markdown_notes_artifact,
    initialize_markdown_notes_workspace,
)


def _gates(report) -> dict[str, bool]:
    return {gate.name: gate.passed for gate in report.gates}


@pytest.fixture(scope="module")
def markdown_notes_baseline(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return initialize_markdown_notes_workspace(tmp_path_factory.mktemp("notes-baseline"))


@pytest.fixture
def notes_workspace(tmp_path: Path, markdown_notes_baseline: Path) -> Path:
    target = tmp_path / "notes"
    shutil.copytree(markdown_notes_baseline, target, ignore=shutil.ignore_patterns(".git"))
    return target


def test_contract_pins_offline_work_and_progress_rules() -> None:
    for requirement in (
        "index.html、app.js、app.test.js",
        "浏览器本地存储",
        ".md 文件",
        "不得访问网络、CDN 或安装第三方依赖",
        "node --test app.test.js",
        "不要宣称已完成",
        "不要执行 `open`",
    ):
        assert requirement in MARKDOWN_NOTES_TASK_CONTRACT


def test_initializer_creates_truthful_existing_notes_page(tmp_path: Path) -> None:
    workspace = initialize_markdown_notes_workspace(tmp_path / "notes")

    assert {path.name for path in workspace.iterdir()} == {
        ".git",
        "TASK_CONTRACT.md",
        "index.html",
        "app.js",
        "app.test.js",
    }
    source = (workspace / "app.js").read_text(encoding="utf-8")
    assert "localStorage" not in source
    assert "Blob" not in source
    assert "download" not in source
    page = (workspace / "index.html").read_text(encoding="utf-8")
    assert 'id="note-editor"' in page
    assert 'id="preview"' in page
    assert "http://" not in page
    assert "https://" not in page
    assert "http://" not in source
    assert "https://" not in source

    report = check_markdown_notes_artifact(workspace)
    assert report.passed is False
    assert _gates(report) == {
        "browser_entry": True,
        "autosave": False,
        "reload": False,
        "export": False,
        "workspace_hygiene": True,
    }


def test_initializer_refuses_nonempty_directory_without_modifying_it(tmp_path: Path) -> None:
    occupied = tmp_path / "occupied"
    occupied.mkdir()
    kept = occupied / "keep.txt"
    kept.write_text("user data", encoding="utf-8")

    with pytest.raises(ValueError, match="empty"):
        initialize_markdown_notes_workspace(occupied)

    assert kept.read_text(encoding="utf-8") == "user data"


def test_baseline_is_not_falsely_reported_as_completed(
    notes_workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        markdown_notes_artifact,
        "_run_bounded_process",
        lambda *args, **kwargs: (
            b'NOVA_MARKDOWN_NOTES_RESULT={"autosave":false,"reload":false,"export":false}\n',
            0,
            (),
        ),
    )
    report = check_markdown_notes_artifact(notes_workspace)

    assert report.passed is False
    assert _gates(report) == {
        "browser_entry": True,
        "autosave": False,
        "reload": False,
        "export": False,
        "workspace_hygiene": True,
    }


def test_exact_all_true_result_marks_a_completed_artifact(
    notes_workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app_test = notes_workspace / "app.test.js"
    app_test.write_text(
        app_test.read_text(encoding="utf-8").replace(
            '"autosave":false,"reload":false,"export":false',
            '"autosave":true,"reload":true,"export":true',
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        markdown_notes_artifact,
        "_run_bounded_process",
        lambda *args, **kwargs: (
            b'NOVA_MARKDOWN_NOTES_RESULT={"autosave":true,"reload":true,"export":true}\n',
            0,
            (),
        ),
    )

    report = check_markdown_notes_artifact(notes_workspace)

    assert report.passed is True
    assert _gates(report) == {
        "browser_entry": True,
        "autosave": True,
        "reload": True,
        "export": True,
        "workspace_hygiene": True,
    }


def test_missing_required_contract_file_turns_browser_gate_red(notes_workspace: Path) -> None:
    app_test = notes_workspace / "app.test.js"
    app_test.write_text(
        app_test.read_text(encoding="utf-8").replace(
            '"autosave":false,"reload":false,"export":false',
            '"autosave":true,"reload":true,"export":true',
        ),
        encoding="utf-8",
    )
    (notes_workspace / "TASK_CONTRACT.md").unlink()

    report = check_markdown_notes_artifact(notes_workspace)

    gate = next(gate for gate in report.gates if gate.name == "browser_entry")
    assert gate.passed is False
    assert "unexpected_file" in gate.findings


def test_oversized_source_is_rejected_without_reading_unbounded_content(
    notes_workspace: Path,
) -> None:
    (notes_workspace / "app.js").write_bytes(b"x" * (1024 * 1024))

    report = check_markdown_notes_artifact(notes_workspace)

    browser = next(gate for gate in report.gates if gate.name == "browser_entry")
    hygiene = next(gate for gate in report.gates if gate.name == "workspace_hygiene")
    assert browser.passed is False
    assert "oversized_file" in browser.findings
    assert hygiene.passed is False
    assert "oversized_file" in hygiene.findings


def test_node_output_flood_is_aggregate_bounded_without_body_leak(notes_workspace: Path) -> None:
    (notes_workspace / "app.test.js").write_text(
        'process.stdout.write("LEAK_SENTINEL".repeat(12000));\n'
        'process.stderr.write("LEAK_SENTINEL".repeat(12000));\n',
        encoding="utf-8",
    )

    report = check_markdown_notes_artifact(notes_workspace)

    autosave = next(gate for gate in report.gates if gate.name == "autosave")
    assert autosave.passed is False
    assert "tests_output_overflow" in autosave.findings
    assert "LEAK_SENTINEL" not in str(report)


def test_oversized_test_source_is_not_executed(tmp_path: Path, notes_workspace: Path) -> None:
    side_effect = tmp_path / "node-was-run"
    (notes_workspace / "app.test.js").write_text(
        "//"
        + ("x" * (1024 * 1024))
        + f"\nrequire('node:fs').writeFileSync({str(side_effect)!r}, 'ran');\n",
        encoding="utf-8",
    )

    report = check_markdown_notes_artifact(notes_workspace)

    autosave = next(gate for gate in report.gates if gate.name == "autosave")
    assert autosave.passed is False
    assert "tests_failed" in autosave.findings
    assert side_effect.exists() is False


def test_fifo_test_source_fails_promptly_without_starting_node(
    notes_workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    test_source = notes_workspace / "app.test.js"
    test_source.unlink()
    os.mkfifo(test_source)
    started_node = False

    def unexpected_runner(*args, **kwargs):
        nonlocal started_node
        started_node = True
        raise AssertionError("Node must not run for a FIFO test source")

    monkeypatch.setattr(markdown_notes_artifact, "_run_bounded_process", unexpected_runner)
    completed = threading.Event()
    reports = []

    def check() -> None:
        reports.append(check_markdown_notes_artifact(notes_workspace))
        completed.set()

    thread = threading.Thread(target=check, daemon=True)
    thread.start()

    assert completed.wait(timeout=0.5)
    assert started_node is False
    autosave = next(gate for gate in reports[0].gates if gate.name == "autosave")
    assert autosave.passed is False
    assert "tests_failed" in autosave.findings


def test_output_overflow_reaps_spawned_descendant(tmp_path: Path, notes_workspace: Path) -> None:
    child_pid = tmp_path / "child.pid"
    (notes_workspace / "app.test.js").write_text(
        "const { spawn } = require('node:child_process');\n"
        "const fs = require('node:fs');\n"
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\n"
        f"fs.writeFileSync({str(child_pid)!r}, String(child.pid));\n"
        'process.stdout.write("x".repeat(100000));\n',
        encoding="utf-8",
    )

    try:
        report = check_markdown_notes_artifact(notes_workspace)
        autosave = next(gate for gate in report.gates if gate.name == "autosave")
        assert "tests_output_overflow" in autosave.findings
        assert child_pid.is_file()
        pid = int(child_pid.read_text(encoding="utf-8"))
        assert _wait_for_pid_exit(pid)
    finally:
        if child_pid.is_file():
            pid = int(child_pid.read_text(encoding="utf-8"))
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def _wait_for_pid_exit(pid: int) -> bool:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.02)
    return False


@pytest.mark.parametrize(
    ("mutation", "failed_gate", "finding"),
    [
        ("remote", "browser_entry", "remote_reference"),
        ("secret", "workspace_hygiene", "secret_material"),
        ("binary", "workspace_hygiene", "binary_file"),
        ("reload", "reload", "reload_failed"),
    ],
)
def test_mutations_turn_their_named_gate_red(
    notes_workspace: Path,
    monkeypatch: pytest.MonkeyPatch,
    mutation: str,
    failed_gate: str,
    finding: str,
) -> None:
    app_test = notes_workspace / "app.test.js"
    app_test.write_text(
        app_test.read_text(encoding="utf-8").replace(
            '"autosave":false,"reload":false,"export":false',
            '"autosave":true,"reload":true,"export":true',
        ),
        encoding="utf-8",
    )
    if mutation == "remote":
        (notes_workspace / "index.html").write_text(
            '<script src="https://example.invalid/app.js"></script>', encoding="utf-8"
        )
    elif mutation == "secret":
        (notes_workspace / "credentials.txt").write_text(
            "OPENAI_API_KEY=" + "".join(("s", "k-secret-sentinel-value")),
            encoding="utf-8",
        )
    elif mutation == "binary":
        (notes_workspace / "capture.bin").write_bytes(b"\x00\x01\x02")
    elif mutation == "reload":
        app_test.write_text(
            app_test.read_text(encoding="utf-8").replace(
                '"autosave":true,"reload":true,"export":true',
                '"autosave":true,"reload":false,"export":true',
            ),
            encoding="utf-8",
        )
        monkeypatch.setattr(
            markdown_notes_artifact,
            "_run_bounded_process",
            lambda *args, **kwargs: (
                b'NOVA_MARKDOWN_NOTES_RESULT={"autosave":true,"reload":false,"export":true}\n',
                0,
                (),
            ),
        )

    report = check_markdown_notes_artifact(notes_workspace)

    gate = next(gate for gate in report.gates if gate.name == failed_gate)
    assert gate.passed is False
    assert finding in gate.findings


def test_static_safety_failure_does_not_execute_node(
    notes_workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (notes_workspace / "index.html").write_text(
        '<script src="https://example.invalid/app.js"></script>', encoding="utf-8"
    )

    def unexpected_runner(*args, **kwargs):
        raise AssertionError("Node must not run after a static safety gate failed")

    monkeypatch.setattr(markdown_notes_artifact, "_run_bounded_process", unexpected_runner)

    report = check_markdown_notes_artifact(notes_workspace)

    browser = next(gate for gate in report.gates if gate.name == "browser_entry")
    assert browser.passed is False
    assert "remote_reference" in browser.findings
