"""Bounded native-async transport for one opaque Codex turn."""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import tempfile
import unicodedata
from collections.abc import Awaitable, Callable, Mapping
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from nova_audio_agent.clock import Clock, RealClock
from nova_audio_agent.executors.codex import (
    ADAPTER_TIMEOUT,
    CodexAdapterDeadlineExceeded,
    CodexProcessStatus,
    CodexRunDeadline,
    CodexTransportResult,
)
from nova_audio_agent.executors.codex_jsonl import (
    CodexJsonlParser,
    CodexProtocolError,
    CodexProtocolSummary,
)
from nova_audio_agent.executors.codex_preflight import (
    CODEX_ROOT_OVERRIDES,
    CodexPreflight,
    CodexPreflightReport,
    ProcessGroupCleanupResult,
    _finish_process_cleanup,
    _filtered_environment,
)
from nova_audio_agent.process_tree import (
    KILL_SIGNAL,
    TERMINATE_SIGNAL,
    signal_tree_async,
    spawn_supervision_kwargs,
    tree_alive,
)

PROCESS_TIMEOUT = 520.0
TERMINATE_GRACE = 5.0
_CLEANUP_PHASES = 6
_CLEANUP_RESERVE = TERMINATE_GRACE * _CLEANUP_PHASES
STDERR_LIMIT = 64 * 1024
FINAL_MESSAGE_BYTE_LIMIT = 64 * 1024
FINAL_MESSAGE_TEXT_LIMIT = 4000
_CLEANUP_CLOCK = RealClock()

_EXEC_OPTIONS = (
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
)


class _Preflight(Protocol):
    async def run(self, *, timeout: float) -> CodexPreflightReport: ...


class _Stdin(Protocol):
    def write(self, data: bytes) -> None: ...

    async def drain(self) -> None: ...

    def close(self) -> None: ...

    async def wait_closed(self) -> None: ...


class _Process(Protocol):
    stdin: _Stdin | None
    stdout: asyncio.StreamReader | None
    stderr: asyncio.StreamReader | None
    returncode: int | None
    pid: int

    async def wait(self) -> int: ...

    def terminate(self) -> None: ...

    def kill(self) -> None: ...


ProcessFactory = Callable[..., Awaitable[_Process]]
Waiter = Callable[
    [tuple[asyncio.Task[object], ...], float],
    Awaitable[tuple[object, ...]],
]
Cleanup = Callable[..., Awaitable[tuple[bool, ProcessGroupCleanupResult]]]


@dataclass(frozen=True, slots=True)
class _PrivateOutput:
    path: Path
    descriptor: int


class _CleanupFailure(RuntimeError):
    """Credential-free failure to prove worker process-group cleanup."""


class CodexTransport:
    """Run a fixed `codex exec` process and return only bounded evidence."""

    def __init__(
        self,
        *,
        binary: str,
        workspace: Path,
        api_key: str | None = None,
        preflight: _Preflight | None = None,
        process_factory: ProcessFactory | None = None,
        environ: Mapping[str, str] | None = None,
        _waiter: Waiter | None = None,
        _cleanup: Cleanup | None = None,
        _clock: Clock | None = None,
    ) -> None:
        self._binary = binary
        self._workspace = workspace
        self._api_key = api_key
        self._environ = dict(os.environ) if environ is None else dict(environ)
        self._preflight = (
            CodexPreflight(
                binary=binary,
                workspace=workspace,
                api_key=api_key,
                environ=self._environ,
            )
            if preflight is None
            else preflight
        )
        self._process_factory: ProcessFactory = (
            asyncio.create_subprocess_exec if process_factory is None else process_factory
        )
        self._waiter = _wait_for_tasks if _waiter is None else _waiter
        self._cleanup = _finish_process_cleanup if _cleanup is None else _cleanup
        self._clock = RealClock() if _clock is None else _clock

    async def preflight(
        self,
        *,
        deadline: CodexRunDeadline | None = None,
    ) -> Mapping[str, Any]:
        deadline = self._deadline(deadline)
        remaining = self._remaining(deadline)
        if remaining <= 0:
            raise CodexAdapterDeadlineExceeded
        report = await self._preflight.run(timeout=remaining)
        if self._remaining(deadline) <= 0:
            raise CodexAdapterDeadlineExceeded
        return report.to_mapping()

    async def run(
        self,
        work_order: str,
        *,
        on_status: Callable[[CodexProcessStatus], None],
        deadline: CodexRunDeadline | None = None,
    ) -> CodexTransportResult:
        deadline = self._deadline(deadline)
        if self._remaining(deadline) <= 0:
            raise CodexAdapterDeadlineExceeded
        private_output = _create_private_output(self._workspace)
        try:
            result = await self._run_with_private_output(
                work_order,
                private_output=private_output,
                on_status=on_status,
                deadline=deadline,
            )
        except BaseException:
            try:
                _finalize_private_output(private_output)
            except BaseException:
                pass
            raise
        cleanup_ok = _finalize_private_output(private_output)
        if self._remaining(deadline) <= 0:
            if result.classification == "refused":
                return CodexTransportResult(
                    classification="refused",
                    code="adapter_timeout",
                    content={},
                )
            content = dict(result.content)
            content.pop("result", None)
            return CodexTransportResult(
                classification="uncertain",
                code="adapter_timeout",
                content=content,
            )
        if cleanup_ok or result.classification == "refused":
            return result
        content = dict(result.content)
        content.pop("result", None)
        return CodexTransportResult(
            classification="uncertain",
            code="transport_failure",
            content=content,
        )

    async def _run_with_private_output(
        self,
        work_order: str,
        *,
        private_output: _PrivateOutput,
        on_status: Callable[[CodexProcessStatus], None],
        deadline: CodexRunDeadline,
    ) -> CodexTransportResult:
        output_path = private_output.path
        process: _Process | None = None
        tasks: tuple[asyncio.Task[object], ...] = ()
        streams: tuple[asyncio.StreamReader, ...] = ()
        stdout_task: asyncio.Task[object] | None = None
        argv = (
            self._binary,
            *CODEX_ROOT_OVERRIDES,
            *_EXEC_OPTIONS,
            "-C",
            str(self._workspace),
            "-o",
            str(output_path),
            "-",
        )
        env = _filtered_environment(self._environ, self._api_key)
        try:
            process = await self._process_factory(
                *argv,
                cwd=self._workspace,
                env=env,
                **spawn_supervision_kwargs(),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except (asyncio.CancelledError, KeyboardInterrupt, SystemExit):
            raise
        except BaseException:
            return CodexTransportResult(
                classification="refused",
                code="spawn_failed",
                content={},
            )

        parser = CodexJsonlParser()
        try:
            on_status(CodexProcessStatus(running=True, exited=False))
            if process.stdout is None or process.stderr is None:
                raise RuntimeError("missing process stream")
            streams = (process.stdout, process.stderr)
            stdin_task: asyncio.Task[object] = asyncio.create_task(
                _write_work_order(process, work_order)
            )
            stdout_task = asyncio.create_task(_drain_stdout(process.stdout, parser))
            stderr_task: asyncio.Task[object] = asyncio.create_task(_drain_stderr(process.stderr))
            wait_task: asyncio.Task[object] = asyncio.create_task(process.wait())
            tasks = (stdin_task, stdout_task, stderr_task, wait_task)
            wait_timeout = min(
                PROCESS_TIMEOUT,
                max(0.0, self._remaining(deadline) - _CLEANUP_RESERVE),
            )
            if wait_timeout <= 0:
                raise TimeoutError
            results = await self._waiter(tasks, wait_timeout)
            exit_code = results[-1]
            if type(exit_code) is not int:
                raise RuntimeError("invalid process exit")
        except asyncio.CancelledError:
            try:
                await self._clean_started_process(process, tasks, streams, deadline=deadline)
            except BaseException:
                pass
            _emit_exit_status(
                process,
                terminal=None,
                on_status=on_status,
            )
            raise
        except TimeoutError:
            try:
                stop = await self._clean_started_process(
                    process,
                    tasks,
                    streams,
                    deadline=deadline,
                )
                code = "timeout"
            except _CleanupFailure:
                stop = "none"
                code = "transport_failure"
            return self._uncertain_after_cleanup(
                code=code,
                process=process,
                stop=stop,
                parser=parser,
                stdout_task=stdout_task,
                output_path=output_path,
                output_descriptor=private_output.descriptor,
                on_status=on_status,
                deadline=deadline,
            )
        except CodexProtocolError as exc:
            try:
                stop = await self._clean_started_process(
                    process,
                    tasks,
                    streams,
                    deadline=deadline,
                )
                code = _protocol_code(exc.code)
            except _CleanupFailure:
                stop = "none"
                code = "transport_failure"
            return self._uncertain_after_cleanup(
                code=code,
                process=process,
                stop=stop,
                parser=parser,
                stdout_task=stdout_task,
                output_path=output_path,
                output_descriptor=private_output.descriptor,
                on_status=on_status,
                deadline=deadline,
            )
        except (KeyboardInterrupt, SystemExit):
            try:
                await self._clean_started_process(process, tasks, streams, deadline=deadline)
            except BaseException:
                pass
            raise
        except BaseException:
            try:
                stop = await self._clean_started_process(
                    process,
                    tasks,
                    streams,
                    deadline=deadline,
                )
                code = "stream_failure"
            except _CleanupFailure:
                stop = "none"
                code = "transport_failure"
            return self._uncertain_after_cleanup(
                code=code,
                process=process,
                stop=stop,
                parser=parser,
                stdout_task=stdout_task,
                output_path=output_path,
                output_descriptor=private_output.descriptor,
                on_status=on_status,
                deadline=deadline,
            )

        try:
            await self._clean_started_process(process, tasks, streams, deadline=deadline)
        except _CleanupFailure:
            return self._uncertain_after_cleanup(
                code="transport_failure",
                process=process,
                stop="none",
                parser=parser,
                stdout_task=stdout_task,
                output_path=output_path,
                output_descriptor=private_output.descriptor,
                on_status=on_status,
                deadline=deadline,
            )

        if self._remaining(deadline) <= 0:
            return self._uncertain_after_cleanup(
                code="adapter_timeout",
                process=process,
                stop="none",
                parser=parser,
                stdout_task=stdout_task,
                output_path=output_path,
                output_descriptor=private_output.descriptor,
                on_status=on_status,
                deadline=deadline,
            )

        try:
            summary = parser.close()
        except CodexProtocolError as exc:
            _emit_exit_status(
                process,
                terminal=None,
                on_status=on_status,
            )
            return CodexTransportResult(
                classification="uncertain",
                code=_protocol_code(exc.code),
                content=_content(
                    summary=None,
                    transport_closed=True,
                    exit_code=process.returncode,
                    stop="none",
                    final_message=_try_final_message(
                        output_path,
                        descriptor=private_output.descriptor,
                        credentials=(self._api_key,),
                        home=self._environ.get("HOME"),
                        workspace=self._workspace,
                    ),
                ),
            )

        _emit_exit_status(
            process,
            terminal=summary.terminal,
            on_status=on_status,
        )
        if self._remaining(deadline) <= 0:
            return CodexTransportResult(
                classification="uncertain",
                code="adapter_timeout",
                content=_content(
                    summary=summary,
                    transport_closed=True,
                    exit_code=process.returncode,
                    stop="none",
                    final_message=None,
                ),
            )
        try:
            final_message = _read_final_message(
                output_path,
                descriptor=private_output.descriptor,
                credentials=(self._api_key,),
                home=self._environ.get("HOME"),
                workspace=self._workspace,
            )
        except (CodexProtocolError, OSError) as exc:
            code = (
                _protocol_code(exc.code)
                if isinstance(exc, CodexProtocolError)
                else "transport_failure"
            )
            return CodexTransportResult(
                classification="uncertain",
                code=code,
                content=_content(
                    summary=summary,
                    transport_closed=True,
                    exit_code=process.returncode,
                    stop="none",
                    final_message=None,
                ),
            )
        if self._remaining(deadline) <= 0:
            return CodexTransportResult(
                classification="uncertain",
                code="adapter_timeout",
                content=_content(
                    summary=summary,
                    transport_closed=True,
                    exit_code=process.returncode,
                    stop="none",
                    final_message=None,
                ),
            )
        code = _outcome_code(summary, exit_code)
        return CodexTransportResult(
            classification="completed" if code == "completed" else "uncertain",
            code=code,
            content=_content(
                summary=summary,
                transport_closed=True,
                exit_code=exit_code,
                stop="none",
                final_message=final_message,
            ),
        )

    async def _clean_started_process(
        self,
        process: _Process,
        tasks: tuple[asyncio.Task[object], ...],
        streams: tuple[asyncio.StreamReader, ...],
        *,
        deadline: CodexRunDeadline,
    ) -> str:
        interrupted = False
        cleanup_result: object | None = None
        needs_fallback = False
        grace = min(
            TERMINATE_GRACE,
            self._remaining(deadline) / _CLEANUP_PHASES,
        )
        try:
            interrupted, cleanup_result = await self._cleanup(
                process,
                tasks,
                streams,
                grace=grace,
            )
        except (asyncio.CancelledError, KeyboardInterrupt, SystemExit):
            raise
        except Exception:
            needs_fallback = True
        else:
            needs_fallback = (
                type(cleanup_result) is not ProcessGroupCleanupResult
                or not cleanup_result.leader_exited
                or not cleanup_result.group_gone
            )
        if needs_fallback:
            grace = min(
                TERMINATE_GRACE,
                self._remaining(deadline) / _CLEANUP_PHASES,
            )
            try:
                fallback_interrupted, cleanup_result = await _finish_fallback_cleanup(
                    process,
                    tasks,
                    streams,
                    grace=grace,
                )
                interrupted = interrupted or fallback_interrupted
            except (asyncio.CancelledError, KeyboardInterrupt, SystemExit):
                raise
            except Exception:
                raise _CleanupFailure from None
        if interrupted:
            raise asyncio.CancelledError
        if (
            type(cleanup_result) is not ProcessGroupCleanupResult
            or not cleanup_result.leader_exited
            or not cleanup_result.group_gone
        ):
            raise _CleanupFailure
        return cleanup_result.leader_stop

    def _uncertain_after_cleanup(
        self,
        *,
        code: str,
        process: _Process,
        stop: str,
        parser: CodexJsonlParser,
        stdout_task: asyncio.Task[object] | None,
        output_path: Path,
        output_descriptor: int,
        on_status: Callable[[CodexProcessStatus], None],
        deadline: CodexRunDeadline,
    ) -> CodexTransportResult:
        if self._remaining(deadline) <= 0:
            code = "adapter_timeout"
        transport_closed = (
            stdout_task is not None
            and stdout_task.done()
            and not stdout_task.cancelled()
            and stdout_task.exception() is None
        )
        summary: CodexProtocolSummary | None = None
        if transport_closed:
            try:
                summary = parser.close()
            except CodexProtocolError:
                summary = None
        _emit_exit_status(
            process,
            terminal=None if summary is None else summary.terminal,
            on_status=on_status,
        )
        return CodexTransportResult(
            classification="uncertain",
            code=code,
            content=_content(
                summary=summary,
                transport_closed=transport_closed,
                exit_code=process.returncode,
                stop=stop,
                final_message=(
                    None
                    if self._remaining(deadline) <= 0
                    else _try_final_message(
                        output_path,
                        descriptor=output_descriptor,
                        credentials=(self._api_key,),
                        home=self._environ.get("HOME"),
                        workspace=self._workspace,
                    )
                ),
            ),
        )

    def _deadline(self, deadline: CodexRunDeadline | None) -> CodexRunDeadline:
        if deadline is not None:
            return deadline
        return CodexRunDeadline(
            expires_at=self._clock.now() + ADAPTER_TIMEOUT,
            clock=self._clock,
        )

    def _remaining(self, deadline: CodexRunDeadline) -> float:
        return deadline.remaining()


def _create_private_output(workspace: Path) -> _PrivateOutput:
    descriptor, raw_path = tempfile.mkstemp(
        prefix=".nova-audio-agent-codex-result-",
        dir=workspace,
    )
    try:
        os.fchmod(descriptor, 0o600)
    except BaseException:
        with suppress(OSError):
            os.close(descriptor)
        with suppress(OSError):
            Path(raw_path).unlink()
        raise
    return _PrivateOutput(Path(raw_path), descriptor)


def _finalize_private_output(private_output: _PrivateOutput) -> bool:
    """Scrub retained bytes and unlink only the originally-created inode."""

    descriptor = private_output.descriptor
    path = private_output.path
    scrubbed = False
    removed = False
    try:
        original = os.fstat(descriptor)
        os.ftruncate(descriptor, 0)
        os.fsync(descriptor)
        scrubbed = True

        try:
            visible = path.lstat()
        except FileNotFoundError:
            removed = os.fstat(descriptor).st_nlink == 0
        else:
            same_inode = (visible.st_dev, visible.st_ino) == (
                original.st_dev,
                original.st_ino,
            )
            if same_inode:
                path.unlink()
                removed = os.fstat(descriptor).st_nlink == 0
    except OSError:
        pass
    finally:
        with suppress(OSError):
            os.close(descriptor)
    return scrubbed and removed


async def _write_work_order(process: _Process, work_order: str) -> None:
    stdin = process.stdin
    if stdin is None:
        raise RuntimeError("missing stdin")
    try:
        stdin.write(work_order.strip().encode("utf-8"))
        await stdin.drain()
    finally:
        stdin.close()
        await stdin.wait_closed()


async def _drain_stdout(
    stream: asyncio.StreamReader,
    parser: CodexJsonlParser,
) -> None:
    while True:
        try:
            line = await stream.readline()
        except (ValueError, asyncio.LimitOverrunError):
            raise CodexProtocolError("line_too_large") from None
        if not line:
            return
        parser.feed(line)


async def _drain_stderr(stream: asyncio.StreamReader) -> None:
    total = 0
    while True:
        chunk = await stream.read(min(64 * 1024, STDERR_LIMIT - total + 1))
        if not chunk:
            return
        total += len(chunk)
        if total > STDERR_LIMIT:
            raise CodexProtocolError("stderr_too_large")


async def _wait_for_tasks(
    tasks: tuple[asyncio.Task[object], ...],
    timeout: float,
) -> tuple[object, ...]:
    async with asyncio.timeout(timeout):
        return tuple(await asyncio.gather(*tasks))


async def _fallback_process_cleanup(
    process: _Process,
    tasks: tuple[asyncio.Task[object], ...],
    streams: tuple[asyncio.StreamReader, ...],
    *,
    grace: float,
) -> tuple[bool, ProcessGroupCleanupResult]:
    """Independent minimal cleanup used only if the shared helper fails."""

    leader_was_running = process.returncode is None
    leader_stop: str = "none"
    group_stop: str = "none"
    group_id = process.pid
    group_gone = not tree_alive(group_id)

    if not group_gone:
        if await _fallback_signal(process, TERMINATE_SIGNAL):
            group_stop = "terminate"
        _, group_gone = await asyncio.gather(
            _fallback_reap(process, grace=grace),
            _fallback_wait_group(group_id, grace=grace),
        )
        if leader_was_running and process.returncode is not None:
            leader_stop = "terminate"
    elif process.returncode is None:
        try:
            process.terminate()
        except (OSError, ProcessLookupError):
            pass
        await _fallback_reap(process, grace=grace)
        if process.returncode is not None:
            leader_stop = "terminate"

    if not group_gone:
        if await _fallback_signal(process, KILL_SIGNAL):
            group_stop = "kill"
        _, group_gone = await asyncio.gather(
            _fallback_reap(process, grace=grace),
            _fallback_wait_group(group_id, grace=grace),
        )
        if leader_was_running and leader_stop == "none" and process.returncode is not None:
            leader_stop = "kill"
    elif process.returncode is None:
        try:
            process.kill()
        except (OSError, ProcessLookupError):
            pass
        await _fallback_reap(process, grace=grace)
        if leader_was_running and process.returncode is not None:
            leader_stop = "kill"

    for task in tasks:
        task.cancel()
    try:
        async with asyncio.timeout(grace):
            await asyncio.gather(*tasks, return_exceptions=True)
    except TimeoutError:
        pass
    for stream in streams:
        try:
            async with asyncio.timeout(grace):
                while await stream.read(64 * 1024):
                    pass
        except Exception:
            break
    _fallback_close_transport(process)
    return False, ProcessGroupCleanupResult(
        leader_stop=leader_stop,  # type: ignore[arg-type]
        group_stop=group_stop,  # type: ignore[arg-type]
        leader_exited=process.returncode is not None,
        group_gone=group_gone,
    )


async def _finish_fallback_cleanup(
    process: _Process,
    tasks: tuple[asyncio.Task[object], ...],
    streams: tuple[asyncio.StreamReader, ...],
    *,
    grace: float,
) -> tuple[bool, ProcessGroupCleanupResult]:
    cleanup = asyncio.create_task(
        _fallback_process_cleanup(
            process,
            tasks,
            streams,
            grace=grace,
        )
    )
    interrupted = False
    while not cleanup.done():
        try:
            await asyncio.shield(cleanup)
        except asyncio.CancelledError:
            interrupted = True
    _, result = cleanup.result()
    return interrupted, result


async def _fallback_signal(process: _Process, selected_signal: int) -> bool:
    """Signal the whole tree, falling back to the leader handle where there is no tree reach.

    Async because the win32 half of a tree signal is a blocking `taskkill` spawn; the leader
    fallbacks below are instant either way.
    """
    if await signal_tree_async(process.pid, selected_signal):
        return True
    if os.name == "posix":
        return False
    try:
        if selected_signal == TERMINATE_SIGNAL:
            process.terminate()
        else:
            process.kill()
    except (OSError, ProcessLookupError):
        return False
    return True


async def _fallback_wait_group(group_id: int, *, grace: float) -> bool:
    deadline = asyncio.get_running_loop().time() + grace
    while tree_alive(group_id):
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            return False
        await _CLEANUP_CLOCK.sleep(min(0.01, remaining))
    return True


async def _fallback_reap(process: _Process, *, grace: float) -> None:
    if process.returncode is not None:
        return
    try:
        async with asyncio.timeout(grace):
            await process.wait()
    except TimeoutError:
        pass


def _fallback_close_transport(process: _Process) -> None:
    try:
        transport = process._transport  # type: ignore[attr-defined]
        for descriptor in (0, 1, 2):
            pipe = transport.get_pipe_transport(descriptor)
            if pipe is not None and not pipe.is_closing():
                pipe.close()
        if not transport.is_closing():
            transport.close()
    except Exception:
        pass


def _outcome_code(summary: CodexProtocolSummary, exit_code: int) -> str:
    if summary.terminal == "failed":
        return "turn_failed"
    if exit_code != 0:
        return "nonzero_exit"
    return "completed"


def _content(
    *,
    summary: CodexProtocolSummary | None,
    transport_closed: bool,
    exit_code: int | None,
    stop: str,
    final_message: Mapping[str, Any] | None,
) -> dict[str, Any]:
    content: dict[str, Any] = {
        "events": [] if summary is None else [dict(event) for event in summary.events],
        "protocol": {
            "thread_started": False if summary is None else summary.thread_started,
            "turn_started": False if summary is None else summary.turn_started,
            "terminal": None if summary is None else summary.terminal,
            "transport_closed": transport_closed,
            "unknown_event_count": 0 if summary is None else summary.unknown_event_count,
        },
        "process": {
            "started": True,
            "exit_code": exit_code,
            "stop": stop,
        },
    }
    if final_message is not None:
        content["result"] = {"final_message": dict(final_message)}
    return content


def _read_final_message(
    path: Path,
    *,
    descriptor: int | None,
    credentials: tuple[str | None, ...],
    home: str | None,
    workspace: Path,
) -> dict[str, Any]:
    if descriptor is None:
        with path.open("rb") as stream:
            raw = stream.read(FINAL_MESSAGE_BYTE_LIMIT + 1)
    else:
        os.lseek(descriptor, 0, os.SEEK_SET)
        chunks: list[bytes] = []
        total = 0
        while total <= FINAL_MESSAGE_BYTE_LIMIT:
            chunk = os.read(
                descriptor,
                min(64 * 1024, FINAL_MESSAGE_BYTE_LIMIT + 1 - total),
            )
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        raw = b"".join(chunks)
    if len(raw) > FINAL_MESSAGE_BYTE_LIMIT:
        raise CodexProtocolError("final_message_too_large")
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        raise CodexProtocolError("transport_failure") from None
    normalized = unicodedata.normalize("NFC", text)
    for credential in credentials:
        if credential:
            normalized = normalized.replace(credential, "[REDACTED]")
    normalized = normalized.replace(str(workspace), "[WORKSPACE]")
    if home:
        normalized = normalized.replace(home, "[HOME]")
    normalized = _PRIVATE_KEY.sub("[PRIVATE_KEY]", normalized)
    for pattern in _CREDENTIAL_PATTERNS:
        normalized = pattern.sub("[REDACTED]", normalized)
    normalized = "".join(
        " " if unicodedata.category(char).startswith("C") else char for char in normalized
    )
    retained = normalized[:FINAL_MESSAGE_TEXT_LIMIT]
    return {
        "text": retained,
        "original_chars": len(normalized),
        "truncated": len(normalized) > FINAL_MESSAGE_TEXT_LIMIT,
        "sha256": hashlib.sha256(normalized.encode("utf-8")).hexdigest(),
    }


def _try_final_message(
    path: Path,
    *,
    descriptor: int | None,
    credentials: tuple[str | None, ...],
    home: str | None,
    workspace: Path,
) -> Mapping[str, Any] | None:
    try:
        return _read_final_message(
            path,
            descriptor=descriptor,
            credentials=credentials,
            home=home,
            workspace=workspace,
        )
    except (CodexProtocolError, OSError):
        return None


def _emit_exit_status(
    process: _Process,
    *,
    terminal: str | None,
    on_status: Callable[[CodexProcessStatus], None],
) -> None:
    if process.returncode is None:
        return
    try:
        on_status(
            CodexProcessStatus(
                running=False,
                exited=True,
                terminal=terminal if terminal in {"completed", "failed"} else None,
                exit_code=process.returncode,
            )
        )
    except (KeyboardInterrupt, SystemExit):
        raise
    except BaseException:
        pass


def _protocol_code(code: object) -> str:
    if code == "line_too_large":
        return "stdout_too_large"
    if code in {
        "malformed_jsonl",
        "missing_terminal",
        "stdout_too_large",
        "stderr_too_large",
        "final_message_too_large",
        "transport_failure",
    }:
        return code
    return "protocol_error"


_PRIVATE_KEY = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
    flags=re.DOTALL,
)
_CREDENTIAL_PATTERNS = (
    re.compile(
        r"""(?ix)
        \\?["']?
        (?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key)
        \\?["']?
        (?:\s|\\[trn])* [:=] (?:\s|\\[trn])*
        \\?["']? [A-Za-z0-9._~+/=-]{8,} \\?["']?
        """
    ),
    re.compile(r"\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
    re.compile(r"\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{12,}\b"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{12,}"),
    re.compile(r"(?i)\b(?:api[_ -]?key|token|secret)\s*[:=]\s*\S{8,}"),
    re.compile(
        r"(?<![A-Za-z0-9_~+/=-])(?=[A-Za-z0-9_~+/=-]{48,}"
        r"(?![A-Za-z0-9_~+/=-]))(?=[A-Za-z0-9_~+/=-]*[A-Za-z])"
        r"(?=[A-Za-z0-9_~+/=-]*\d)[A-Za-z0-9_~+/=-]+"
    ),
)
