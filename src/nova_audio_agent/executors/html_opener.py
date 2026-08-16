"""Host-owned, fixed-path macOS opener for a completed HTML artifact."""

from __future__ import annotations

import asyncio
import os
import stat
import sys
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

HtmlOpenCode = Literal[
    "opened",
    "missing",
    "not_regular",
    "symlink",
    "outside_workspace",
    "unsupported_platform",
    "open_failed",
]


@dataclass(frozen=True, slots=True)
class HtmlOpenResult:
    code: HtmlOpenCode


class HtmlOpener(Protocol):
    async def open_index(self) -> HtmlOpenResult: ...


class _Process(Protocol):
    async def wait(self) -> int: ...

    def kill(self) -> None: ...


ProcessFactory = Callable[..., Awaitable[_Process]]


class BoundedHtmlOpener:
    """Open exactly one real `index.html` beneath one real workspace."""

    def __init__(
        self,
        workspace: Path,
        *,
        process_factory: ProcessFactory = asyncio.create_subprocess_exec,
        platform: str = sys.platform,
    ) -> None:
        absolute = workspace.absolute()
        try:
            mode = os.lstat(absolute).st_mode
        except OSError:
            raise ValueError("HTML opener workspace must be a real directory") from None
        if not stat.S_ISDIR(mode):
            raise ValueError("HTML opener workspace must be a real directory")
        self._workspace = absolute.resolve(strict=True)
        self._process_factory = process_factory
        self._platform = platform

    @property
    def workspace(self) -> Path:
        return self._workspace

    async def open_index(self) -> HtmlOpenResult:
        if self._platform != "darwin":
            return HtmlOpenResult("unsupported_platform")
        candidate = self._workspace / "index.html"
        try:
            mode = os.lstat(candidate).st_mode
        except FileNotFoundError:
            return HtmlOpenResult("missing")
        except OSError:
            return HtmlOpenResult("not_regular")
        if stat.S_ISLNK(mode):
            return HtmlOpenResult("symlink")
        if not stat.S_ISREG(mode):
            return HtmlOpenResult("not_regular")
        try:
            resolved = candidate.resolve(strict=True)
        except OSError:
            return HtmlOpenResult("not_regular")
        if not resolved.is_relative_to(self._workspace):
            return HtmlOpenResult("outside_workspace")
        try:
            process = await self._process_factory(
                "/usr/bin/open",
                str(resolved),
                cwd=self._workspace,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            async with asyncio.timeout(5.0):
                returncode = await process.wait()
        except TimeoutError:
            process.kill()
            with suppress(Exception):
                await process.wait()
            return HtmlOpenResult("open_failed")
        except (OSError, RuntimeError, ValueError, TypeError):
            return HtmlOpenResult("open_failed")
        return HtmlOpenResult("opened" if returncode == 0 else "open_failed")
