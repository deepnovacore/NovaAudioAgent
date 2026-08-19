"""The immutable ``event_report`` fixture: copy it, hash it, verify it independently.

Precedent: :func:`nova_audio_agent.evals.tetris_artifact.create_contracted_workspace`. The
difference is that this fixture ships as a template directory instead of a single
embedded contract string, because a worker has to read several files before it can
implement anything.

Nothing here trusts the worker's own words about the result. The harness hashes every
initial file before dispatch, re-hashes afterwards, and runs the fixture's own test
command itself. ``harness_test_command_passed`` deliberately also requires a plausible
test count: ``python -m unittest`` exits 0 after discovering *zero* tests, so an exit
code alone would turn a deleted suite into a green run.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "event_report"

#: Test count of the pristine fixture. The harness requires at least this many so a
#: suite that was deleted, emptied, or made undiscoverable cannot pass by exiting 0.
EXPECTED_FIXTURE_TESTS = 17

GATE_TESTS_UNCHANGED = "tests_unchanged"
GATE_README_UNCHANGED = "readme_unchanged"
GATE_CHANGES_WITHIN_WORKSPACE = "changes_within_workspace"
GATE_TEST_COMMAND_PASSED = "harness_test_command_passed"

_RAN_TESTS = re.compile(r"^Ran (\d+) tests? in ", re.MULTILINE)
_IGNORED_PARTS = frozenset({"__pycache__", ".git", ".pytest_cache"})
_IGNORED_SUFFIXES = frozenset({".pyc", ".pyo"})


@dataclass(frozen=True, slots=True)
class FixtureGate:
    name: str
    passed: bool
    findings: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class FixtureTestRun:
    passed: bool
    ran: int
    reason: str


def copy_event_report_fixture(destination: Path) -> Path:
    """Copy the pristine template to ``destination`` and return it."""
    if not FIXTURE_ROOT.is_dir():
        raise FileNotFoundError(f"event_report fixture template is missing: {FIXTURE_ROOT}")
    shutil.copytree(
        FIXTURE_ROOT,
        destination,
        ignore=shutil.ignore_patterns(*sorted(_IGNORED_PARTS), "*.pyc"),
    )
    return destination


def workspace_hashes(workspace: Path) -> dict[str, str]:
    """Return ``relative posix path -> sha256`` for every durable file in the workspace.

    Byte-code caches are excluded: running the suite creates them, and the fixture
    contract already says a generated cache is not a deliverable.
    """
    hashes: dict[str, str] = {}
    for path in sorted(workspace.rglob("*")):
        relative = path.relative_to(workspace)
        if _IGNORED_PARTS.intersection(relative.parts):
            continue
        if path.is_symlink() or not path.is_file():
            continue
        if path.suffix.lower() in _IGNORED_SUFFIXES:
            continue
        try:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError:
            digest = "unreadable"
        hashes[relative.as_posix()] = digest
    return hashes


def run_fixture_tests(workspace: Path, *, timeout: float = 300.0) -> FixtureTestRun:
    """Run the fixture's own ``python -m unittest`` from the harness, not from Codex."""
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONIOENCODING": "utf-8",
        "NO_PROXY": "*",
        "no_proxy": "*",
    }
    try:
        completed = subprocess.run(
            [sys.executable, "-B", "-m", "unittest"],
            cwd=workspace,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return FixtureTestRun(passed=False, ran=0, reason="test_command_timeout")
    except OSError:
        return FixtureTestRun(passed=False, ran=0, reason="test_command_not_runnable")

    report = completed.stderr.decode("utf-8", errors="replace")
    match = _RAN_TESTS.search(report)
    ran = int(match.group(1)) if match is not None else 0
    if completed.returncode != 0:
        return FixtureTestRun(passed=False, ran=ran, reason="test_command_failed")
    if ran < EXPECTED_FIXTURE_TESTS:
        return FixtureTestRun(passed=False, ran=ran, reason="too_few_tests_discovered")
    return FixtureTestRun(passed=True, ran=ran, reason="ok")


def verify_workspace(
    workspace: Path,
    *,
    before: Mapping[str, str],
    test_run: FixtureTestRun,
) -> tuple[FixtureGate, ...]:
    """Judge the finished workspace from hashes and the harness's own test run."""
    after = workspace_hashes(workspace)
    return (
        FixtureGate(GATE_TESTS_UNCHANGED, *_unchanged(before, after, "tests/")),
        FixtureGate(GATE_README_UNCHANGED, *_unchanged(before, after, "README.md")),
        FixtureGate(GATE_CHANGES_WITHIN_WORKSPACE, *_contained(workspace)),
        FixtureGate(
            GATE_TEST_COMMAND_PASSED,
            test_run.passed,
            () if test_run.passed else (f"{test_run.reason}:ran={test_run.ran}",),
        ),
    )


def changed_paths(before: Mapping[str, str], after: Mapping[str, str]) -> tuple[str, ...]:
    """Return the relative paths that were created, deleted, or modified."""
    names = sorted(set(before) | set(after))
    return tuple(name for name in names if before.get(name) != after.get(name))


def _unchanged(
    before: Mapping[str, str], after: Mapping[str, str], prefix: str
) -> tuple[bool, tuple[str, ...]]:
    violations = tuple(name for name in changed_paths(before, after) if name.startswith(prefix))
    return not violations, violations


def _contained(workspace: Path) -> tuple[bool, tuple[str, ...]]:
    """A file may only be a regular file that really lives inside the workspace."""
    root = workspace.resolve()
    findings: set[str] = set()
    for path in workspace.rglob("*"):
        relative = path.relative_to(workspace)
        if _IGNORED_PARTS.intersection(relative.parts):
            continue
        if path.is_symlink():
            try:
                path.resolve(strict=True).relative_to(root)
            except (OSError, ValueError):
                findings.add(f"escaping_symlink:{relative.as_posix()}")
            continue
        if path.is_dir() or path.is_file():
            continue
        findings.add(f"not_a_regular_file:{relative.as_posix()}")
    return not findings, tuple(sorted(findings))
