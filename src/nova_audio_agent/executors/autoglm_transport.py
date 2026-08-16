"""One-shot subprocess transport for the isolated AutoGLM iPhone worker."""

from __future__ import annotations

import asyncio
import os
import signal
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit

from nova_audio_agent.clock import Clock, RealClock
from nova_audio_agent.executors.autoglm_protocol import (
    AutoGlmJsonlParser,
    AutoGlmProtocolError,
    AutoGlmWorkerResult,
)

MAX_STDERR_BYTES = 64 * 1024
TERMINATE_GRACE = 5.0
_CLEANUP_RESERVE = TERMINATE_GRACE * 2
_CLEANUP_CLOCK = RealClock()


class AutoGlmTransportFailure(RuntimeError):
    """Credential-free transport failure after at most one worker attempt."""

    def __init__(self, code: str, *, worker_started: bool) -> None:
        super().__init__(code)
        self.code = code
        self.worker_started = worker_started


@dataclass(frozen=True, slots=True)
class AutoGlmRunDeadline:
    """One absolute AutoGLM deadline coupled to the clock that created it."""

    expires_at: float
    clock: Clock

    def remaining(self) -> float:
        return max(0.0, self.expires_at - self.clock.now())


class _Process(Protocol):
    stdout: asyncio.StreamReader | None
    stderr: asyncio.StreamReader | None
    returncode: int | None

    async def wait(self) -> int: ...

    def terminate(self) -> None: ...

    def kill(self) -> None: ...


ProcessFactory = Callable[..., Awaitable[_Process]]


class AutoGlmTransport:
    """Run one literal Safari browse query without retaining worker internals."""

    def __init__(
        self,
        *,
        runner_path: Path,
        external_python: str,
        repo: Path,
        model_endpoint: str,
        model_name: str,
        api_key: str,
        wda_url: str,
        device_id: str | None,
        process_factory: ProcessFactory | None = None,
        environ: Mapping[str, str] | None = None,
        _terminate_grace: float = TERMINATE_GRACE,
    ) -> None:
        self._runner_path = runner_path
        self._external_python = external_python
        self._repo = repo
        self._model_endpoint = model_endpoint
        self._model_name = model_name
        self._api_key = api_key
        self._wda_url = _validate_wda_url(wda_url)
        self._device_id = device_id
        self._process_factory = (
            asyncio.create_subprocess_exec if process_factory is None else process_factory
        )
        self._environ = dict(os.environ) if environ is None else dict(environ)
        self._terminate_grace = _terminate_grace

    async def run_browse(
        self,
        query: str,
        *,
        deadline: AutoGlmRunDeadline,
    ) -> AutoGlmWorkerResult:
        if not isinstance(deadline.clock, RealClock):
            raise AutoGlmTransportFailure("clock_mismatch", worker_started=False)
        remaining = deadline.remaining()
        if remaining <= self._cleanup_reserve:
            raise AutoGlmTransportFailure("timeout", worker_started=False)
        try:
            process = await asyncio.wait_for(
                self._process_factory(
                    *self._argv(),
                    cwd=self._repo,
                    env=self._worker_environment(query),
                    start_new_session=os.name == "posix",
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                ),
                timeout=remaining - self._cleanup_reserve,
            )
        except (asyncio.CancelledError, KeyboardInterrupt, SystemExit):
            raise
        except TimeoutError:
            # Cancellation before create_subprocess_exec returns does not prove that
            # no child crossed the spawn boundary.
            raise AutoGlmTransportFailure("timeout", worker_started=True) from None
        except OSError:
            raise AutoGlmTransportFailure("spawn_failed", worker_started=False) from None
        except BaseException:
            raise AutoGlmTransportFailure("spawn_failed", worker_started=True) from None

        if deadline.remaining() <= self._cleanup_reserve:
            raise AutoGlmTransportFailure(
                "timeout" if await self._stop(process, deadline=deadline) else "transport_failure",
                worker_started=True,
            )
        if process.stdout is None or process.stderr is None:
            raise AutoGlmTransportFailure(
                "stream_failure"
                if await self._stop(process, deadline=deadline)
                else "transport_failure",
                worker_started=True,
            )
        parser = AutoGlmJsonlParser()
        scanner = _CredentialScanner(self._api_key)
        tasks = (
            asyncio.create_task(_drain_stdout(process.stdout, parser, scanner)),
            asyncio.create_task(_drain_stderr(process.stderr, scanner)),
            asyncio.create_task(process.wait()),
        )
        try:
            remaining = deadline.remaining() - self._cleanup_reserve
            if remaining <= 0:
                raise TimeoutError
            exit_code = await asyncio.wait_for(asyncio.gather(*tasks), timeout=remaining)
        except asyncio.CancelledError:
            await self._stop(process, deadline=deadline)
            await _cancel(tasks)
            raise
        except (KeyboardInterrupt, SystemExit):
            await self._stop(process, deadline=deadline)
            await _cancel(tasks)
            raise
        except TimeoutError:
            cleaned = await self._stop(process, deadline=deadline)
            await _cancel(tasks)
            raise AutoGlmTransportFailure(
                "timeout" if cleaned else "transport_failure",
                worker_started=True,
            ) from None
        except AutoGlmProtocolError as exc:
            cleaned = await self._stop(process, deadline=deadline)
            await _cancel(tasks)
            raise AutoGlmTransportFailure(
                exc.code if cleaned else "transport_failure",
                worker_started=True,
            ) from None
        except BaseException:
            cleaned = await self._stop(process, deadline=deadline)
            await _cancel(tasks)
            raise AutoGlmTransportFailure(
                "stream_failure" if cleaned else "transport_failure",
                worker_started=True,
            ) from None

        if not await self._stop(process, deadline=deadline):
            raise AutoGlmTransportFailure("transport_failure", worker_started=True)
        if not isinstance(exit_code[2], int) or exit_code[2] != 0:
            raise AutoGlmTransportFailure("nonzero_exit", worker_started=True)
        try:
            return parser.close()
        except AutoGlmProtocolError as exc:
            raise AutoGlmTransportFailure(exc.code, worker_started=True) from None

    @property
    def _cleanup_reserve(self) -> float:
        return self._terminate_grace * 2

    def _argv(self) -> tuple[str, ...]:
        argv = (
            self._external_python,
            str(self._runner_path),
            "--repo",
            str(self._repo),
            "--base-url",
            self._model_endpoint,
            "--model",
            self._model_name,
            "--wda-url",
            self._wda_url,
        )
        if self._device_id is not None:
            argv += ("--device-id", self._device_id)
        return argv + ("--max-steps", "20")

    def _worker_environment(self, query: str) -> dict[str, str]:
        environment = {
            "NOVA_AUDIO_AGENT_AUTOGLM_API_KEY": self._api_key,
            "NOVA_AUDIO_AGENT_AUTOGLM_QUERY": query,
        }
        path = self._environ.get("PATH")
        if path is not None:
            environment["PATH"] = path
        return environment

    async def _stop(
        self,
        process: _Process,
        *,
        deadline: AutoGlmRunDeadline | None = None,
    ) -> bool:
        if _has_process_group(process):
            if process.returncode is not None and not _group_alive(process):
                return True
            if _signal_group(process, signal.SIGTERM):
                _, group_gone = await asyncio.gather(
                    _wait_for_exit(process, self._grace(deadline)),
                    _wait_for_group_gone(process, self._grace(deadline)),
                )
                if group_gone:
                    return True
                if not _signal_group(process, signal.SIGKILL):
                    return False
                _, group_gone = await asyncio.gather(
                    _wait_for_exit(process, self._grace(deadline)),
                    _wait_for_group_gone(process, self._grace(deadline)),
                )
                return group_gone
        if process.returncode is not None:
            return not _group_alive(process)
        _signal_leader(process, "terminate")
        await _wait_for_exit(process, self._grace(deadline))
        if process.returncode is not None:
            return True
        _signal_leader(process, "kill")
        await _wait_for_exit(process, self._grace(deadline))
        return process.returncode is not None

    def _grace(self, deadline: AutoGlmRunDeadline | None) -> float:
        if deadline is None:
            return self._terminate_grace
        return min(self._terminate_grace, deadline.remaining())


def _validate_wda_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except (TypeError, ValueError):
        raise ValueError("invalid_wda_url") from None
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost"}
        or port != 8100
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("invalid_wda_url")
    return f"http://{parsed.hostname}:8100"


async def _drain_stdout(
    stream: asyncio.StreamReader,
    parser: AutoGlmJsonlParser,
    scanner: _CredentialScanner,
) -> None:
    while line := await _readline(stream):
        scanner.check(line)
        parser.feed(line)


async def _readline(stream: asyncio.StreamReader) -> bytes:
    try:
        return await stream.readline()
    except (ValueError, asyncio.LimitOverrunError):
        raise AutoGlmProtocolError("line_too_large") from None


async def _drain_stderr(stream: asyncio.StreamReader, scanner: _CredentialScanner) -> None:
    total = 0
    while chunk := await stream.read(MAX_STDERR_BYTES - total + 1):
        scanner.check(chunk)
        total += len(chunk)
        if total > MAX_STDERR_BYTES:
            raise AutoGlmProtocolError("stderr_too_large")


async def _cancel(tasks: tuple[asyncio.Task[object], ...]) -> None:
    for task in tasks:
        if not task.done():
            task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


class _CredentialScanner:
    def __init__(self, credential: str) -> None:
        self._credential = credential.encode("utf-8")
        self._tail = b""

    def check(self, chunk: bytes) -> None:
        if not self._credential:
            return
        combined = self._tail + chunk
        if self._credential in combined:
            raise AutoGlmProtocolError("credential_output")
        overlap = len(self._credential) - 1
        self._tail = combined[-overlap:] if overlap else b""


def _signal_group(process: _Process, selected_signal: signal.Signals) -> bool:
    if not _has_process_group(process):
        return False
    try:
        os.killpg(process.pid, selected_signal)  # type: ignore[attr-defined]
    except (OSError, ProcessLookupError):
        return False
    return True


def _group_alive(process: _Process) -> bool:
    if not _has_process_group(process):
        return False
    try:
        os.killpg(process.pid, 0)  # type: ignore[attr-defined]
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _has_process_group(process: _Process) -> bool:
    return os.name == "posix" and isinstance(getattr(process, "pid", None), int)


def _signal_leader(process: _Process, method: str) -> None:
    try:
        getattr(process, method)()
    except (OSError, ProcessLookupError):
        pass


async def _wait_for_exit(process: _Process, timeout: float) -> None:
    if process.returncode is not None or timeout <= 0:
        return
    try:
        await asyncio.wait_for(process.wait(), timeout=timeout)
    except TimeoutError:
        pass


async def _wait_for_group_gone(process: _Process, timeout: float) -> bool:
    deadline = asyncio.get_running_loop().time() + timeout
    while _group_alive(process):
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            return False
        await _CLEANUP_CLOCK.sleep(min(0.01, remaining))
    return True
