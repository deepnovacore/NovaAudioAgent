"""Cross-platform guards: the POSIX-only escape hatches that were closed stay closed.

Each guard is paired with a positive twin, because "no offenders found" and "nothing was
scanned" look identical from the outside. Between them they pin the three properties the
port depends on:

1. Only `process_tree.py` signals a process group, so a second POSIX-only supervision path
   cannot quietly grow back next to it.
2. The fd-3 readiness pipe is gone. The one surviving mention is the defensive scrub in the
   Electron launcher (`delete env.…READY_FD`), which exists precisely so a stale value
   inherited from a parent shell can never be mistaken for a live handshake.
3. The orb never hardcodes a POSIX interpreter path; the venv layout is resolved per target
   platform instead.
"""

from __future__ import annotations

from pathlib import Path

SOURCE_ROOT = Path("src/nova_audio_agent")
ORB_SOURCE = Path("desktop/ambient-orb/src")
PROCESS_TREE = SOURCE_ROOT / "process_tree.py"
BACKEND_LAUNCHER = ORB_SOURCE / "main/backend.mjs"
READY_FD_SCRUB = "delete env.NOVA_AUDIO_AGENT_DESKTOP_READY_FD"
_IGNORED_PARTS = frozenset({"__pycache__", "build", "dist", "node_modules"})


def _sources(root: Path, suffix: str) -> tuple[Path, ...]:
    return tuple(
        sorted(
            path
            for path in root.rglob(f"*{suffix}")
            if path.is_file() and not _IGNORED_PARTS.intersection(path.parts)
        )
    )


def _hits(paths: tuple[Path, ...], needle: str) -> list[str]:
    found = []
    for path in paths:
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if needle in line:
                found.append(f"{path}:{number} {line.strip()}")
    return found


def test_only_process_tree_signals_a_process_group() -> None:
    offenders = _hits(
        tuple(path for path in _sources(SOURCE_ROOT, ".py") if path != PROCESS_TREE),
        "killpg",
    )

    assert offenders == []


def test_process_tree_is_the_one_module_that_owns_the_group_signal() -> None:
    """Positive twin: prove the scan can see a `killpg`, or an empty result means nothing."""
    scanned = _sources(SOURCE_ROOT, ".py")

    assert PROCESS_TREE in scanned
    assert len(scanned) > 20
    assert _hits((PROCESS_TREE,), "killpg")


def test_the_fd3_readiness_pipe_survives_only_as_an_environment_scrub() -> None:
    mentions = _hits(_sources(SOURCE_ROOT, ".py"), "READY_FD") + _hits(
        _sources(ORB_SOURCE, ".mjs"), "READY_FD"
    )
    channels = [mention for mention in mentions if READY_FD_SCRUB not in mention]

    assert channels == []


def test_the_backend_launcher_still_scrubs_an_inherited_ready_fd() -> None:
    """Positive twin: the scrub is the single permitted mention, so it must actually be there."""
    assert _hits((BACKEND_LAUNCHER,), READY_FD_SCRUB)


def test_the_orb_never_hardcodes_a_posix_interpreter_path() -> None:
    assert _hits(_sources(ORB_SOURCE, ".mjs"), "bin/python") == []


def test_the_orb_resolves_the_venv_interpreter_per_platform() -> None:
    """Positive twin: the launcher that could hardcode `bin/python` is in the scanned set."""
    launcher = BACKEND_LAUNCHER.read_text(encoding="utf-8")

    assert BACKEND_LAUNCHER in _sources(ORB_SOURCE, ".mjs")
    assert "'Scripts', 'python.exe'" in launcher
    assert "'bin', 'python'" in launcher


def test_gitattributes_pins_lf_and_marks_png_binary() -> None:
    """A Windows checkout must not silently flip source text to CRLF.

    Many tests match source text with regexes containing literal `\\n` across
    lines; CRLF would break them on the windows-latest electron CI leg, which
    is blocking (no continue-on-error). `.gitattributes` is what keeps every
    platform's working tree normalized to LF.
    """
    gitattributes = Path(".gitattributes")

    assert gitattributes.is_file(), "expected a repo-root .gitattributes"

    lines = gitattributes.read_text(encoding="utf-8").splitlines()

    assert any(line.split("#", 1)[0].split() == ["*", "text=auto", "eol=lf"] for line in lines), (
        "expected a `* text=auto eol=lf` default so every platform's working tree normalizes to LF"
    )
    assert any(line.split("#", 1)[0].split() == ["*.png", "-text"] for line in lines), (
        "expected `*.png -text` so binary tray/build icons are never treated as text"
    )
