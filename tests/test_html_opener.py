from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from nova_audio_agent.executors.html_opener import BoundedHtmlOpener


class _Process:
    def __init__(self, returncode: int) -> None:
        self.returncode = returncode
        self.killed = False

    async def wait(self) -> int:
        return self.returncode

    def kill(self) -> None:
        self.killed = True


class RecordingProcessFactory:
    def __init__(self, *, returncode: int = 0) -> None:
        self.returncode = returncode
        self.calls: list[tuple[tuple[str, ...], dict[str, Any]]] = []

    async def __call__(self, *args: str, **kwargs: Any) -> _Process:
        self.calls.append((args, kwargs))
        return _Process(self.returncode)


async def test_opener_launches_only_exact_regular_workspace_index(tmp_path: Path) -> None:
    index = tmp_path / "index.html"
    index.write_text("<!doctype html>", encoding="utf-8")
    factory = RecordingProcessFactory(returncode=0)

    result = await BoundedHtmlOpener(
        tmp_path,
        process_factory=factory,
        platform="darwin",
    ).open_index()

    assert result.code == "opened"
    assert len(factory.calls) == 1
    args, kwargs = factory.calls[0]
    assert args == ("/usr/bin/open", str(index.resolve()))
    assert kwargs == {
        "cwd": tmp_path.resolve(),
        "stdin": asyncio.subprocess.DEVNULL,
        "stdout": asyncio.subprocess.DEVNULL,
        "stderr": asyncio.subprocess.DEVNULL,
    }


def _prepare_index_case(root: Path, setup: str) -> None:
    index = root / "index.html"
    if setup == "directory":
        index.mkdir()
    elif setup == "symlink":
        outside = root.parent / "outside.html"
        outside.write_text("outside", encoding="utf-8")
        index.symlink_to(outside)


@pytest.mark.parametrize(
    ("setup", "code"),
    [("missing", "missing"), ("directory", "not_regular"), ("symlink", "symlink")],
)
async def test_opener_rejects_unsafe_index_without_spawning(
    tmp_path: Path,
    setup: str,
    code: str,
) -> None:
    _prepare_index_case(tmp_path, setup)
    factory = RecordingProcessFactory(returncode=0)

    result = await BoundedHtmlOpener(
        tmp_path,
        process_factory=factory,
        platform="darwin",
    ).open_index()

    assert result.code == code
    assert factory.calls == []


async def test_opener_rejects_non_macos_without_spawning(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<!doctype html>", encoding="utf-8")
    factory = RecordingProcessFactory(returncode=0)

    result = await BoundedHtmlOpener(
        tmp_path,
        process_factory=factory,
        platform="linux",
    ).open_index()

    assert result.code == "unsupported_platform"
    assert factory.calls == []


async def test_opener_reduces_nonzero_exit_to_bounded_failure(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<!doctype html>", encoding="utf-8")
    factory = RecordingProcessFactory(returncode=7)

    result = await BoundedHtmlOpener(
        tmp_path,
        process_factory=factory,
        platform="darwin",
    ).open_index()

    assert result.code == "open_failed"
    assert "7" not in repr(result)


def test_opener_rejects_workspace_symlink(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(workspace, target_is_directory=True)

    with pytest.raises(ValueError, match="real directory"):
        BoundedHtmlOpener(alias, platform="darwin")
