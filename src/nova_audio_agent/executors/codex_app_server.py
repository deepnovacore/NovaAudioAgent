"""One-process-per-run stdio app-server transport for live Codex turns."""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import signal
import shutil
import tempfile
import unicodedata
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Literal, Protocol

from nova_audio_agent.clock import Clock, RealClock
from nova_audio_agent.executors.codex import (
    ADAPTER_TIMEOUT,
    CodexAdapterDeadlineExceeded,
    CodexProcessStatus,
    CodexRunDeadline,
    CodexTransportResult,
)
from nova_audio_agent.executors.codex_app_server_protocol import (
    AppServerProtocolError,
    AppServerRequestRejected,
    AppServerTurnProjection,
    JsonRpcConnection,
    MAX_JSONL_LINE,
    TurnCompletion,
    validate_effective_config,
    validate_schema_directory,
)
from nova_audio_agent.executors.codex_preflight import (
    CODEX_ROOT_OVERRIDES,
    AsyncioPreflightRunner,
    CodexPreflight,
    CodexPreflightReport,
    _filtered_environment,
)
from nova_audio_agent.ports import PROGRESS_SUMMARY_LIMIT, ProgressPayload

LIVE_APP_SERVER_OPTIONS = (
    "-c",
    "mcp_servers={}",
    "app-server",
    "--strict-config",
    "--stdio",
)
STDERR_LIMIT = 64 * 1024
EXIT_GRACE = 5.0
INTERRUPT_GRACE = 2.0
PROCESS_TREE_POLL_INTERVAL = 0.01
FINAL_TEXT_LIMIT = 4000
FINAL_INPUT_LIMIT = 65_536
DEFAULT_DEVELOPER_INSTRUCTIONS = (
    "First inspect any TASK_CONTRACT.md in the workspace and treat it as acceptance constraints. "
    "Work in named, verifiable increments. Incorporate same-turn user steering promptly. "
    "Before the first tool call, emit a brief user-facing progress message naming the concrete "
    "first step. After each verifiable increment, emit another brief progress message before "
    "continuing. Keep progress factual and never include reasoning, commands, paths, or secrets. "
    "Do not add dependencies unless the task and workspace contract permit them. Before completion, "
    "run every contract check; treat any dependency ban as also forbidding optional or fallback "
    "imports. End with a short semantic summary suitable for conversational delivery."
)

_PRIVATE_KEY = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
    re.DOTALL,
)
_CREDENTIAL = re.compile(r"(?i)(?:bearer\s+|(?:sk|rk|pk)-)[A-Za-z0-9_./+=-]{8,}")


class _Preflight(Protocol):
    async def run(self, *, timeout: float) -> CodexPreflightReport: ...


class _ProtocolProbe(Protocol):
    async def validate(
        self,
        *,
        binary: str,
        workspace: Path,
        env: Mapping[str, str],
        timeout: float,
    ) -> None: ...


class CodexAppServerSchemaProbe:
    """Generate and validate the configured binary's live request schema."""

    def __init__(self) -> None:
        self._runner = AsyncioPreflightRunner()

    async def validate(
        self,
        *,
        binary: str,
        workspace: Path,
        env: Mapping[str, str],
        timeout: float,
    ) -> None:
        try:
            with tempfile.TemporaryDirectory(prefix="nova-codex-app-server-schema-") as directory:
                result = await self._runner.run(
                    (binary, "app-server", "generate-json-schema", "--out", directory),
                    cwd=workspace,
                    env=env,
                    timeout=min(30.0, timeout),
                    stdout_limit=64 * 1024,
                    stderr_limit=64 * 1024,
                )
                if result.returncode != 0:
                    raise AppServerProtocolError("unsupported_protocol")
                validate_schema_directory(Path(directory))
        except (asyncio.CancelledError, KeyboardInterrupt, SystemExit):
            raise
        except AppServerProtocolError:
            raise
        except BaseException:
            raise AppServerProtocolError("unsupported_protocol") from None


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
HomeObserver = Callable[[Path], None]
NotificationObserver = Callable[[str, tuple[str, ...]], None]


@dataclass(frozen=True, slots=True)
class SteerTransportResult:
    code: Literal[
        "accepted",
        "no_active_turn",
        "stale_turn",
        "server_rejected",
        "transport_lost",
    ]
    written: bool


class CodexAppServerTransport:
    """Own a single active app-server process and discard all private protocol bodies."""

    def __init__(
        self,
        *,
        binary: str,
        workspace: Path,
        api_key: str | None = None,
        developer_instructions: str | None = DEFAULT_DEVELOPER_INSTRUCTIONS,
        preflight: _Preflight | None = None,
        process_factory: ProcessFactory | None = None,
        environ: Mapping[str, str] | None = None,
        clock: Clock | None = None,
        home_observer: HomeObserver | None = None,
        notification_observer: NotificationObserver | None = None,
        protocol_probe: _ProtocolProbe | None = None,
    ) -> None:
        self._binary = binary
        self._workspace = workspace
        self._api_key = api_key
        self._developer_instructions = _bounded_developer_instructions(developer_instructions)
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
        self._process_factory = (
            asyncio.create_subprocess_exec if process_factory is None else process_factory
        )
        self._clock = RealClock() if clock is None else clock
        self._home_observer = home_observer
        self._notification_observer = notification_observer
        self._protocol_probe = (
            CodexAppServerSchemaProbe() if protocol_probe is None else protocol_probe
        )
        self._private_home: tempfile.TemporaryDirectory[str] | None = None
        self._process: _Process | None = None
        self._rpc: JsonRpcConnection | None = None
        self._projection: AppServerTurnProjection | None = None
        self._completion: asyncio.Future[TurnCompletion] | None = None
        self._initialized = False
        self._turn_request_written = False
        self._had_turn = False
        self._unexpected_server_request = False
        self._sensitive_inputs: list[str] = []
        self._warm = False
        self._turn_in_flight = False
        self._thread_response: Any = None
        self._thread_id: str | None = None
        self._process_wait: asyncio.Task[int] | None = None
        self._rpc_wait: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._prewarm_lock = asyncio.Lock()
        self._validated_establish = False

    async def preflight(
        self,
        *,
        deadline: CodexRunDeadline | None = None,
    ) -> Mapping[str, Any]:
        remaining = ADAPTER_TIMEOUT if deadline is None else deadline.remaining()
        if remaining <= 0:
            raise CodexAdapterDeadlineExceeded
        report = await self._preflight.run(timeout=remaining)
        if deadline is not None and deadline.remaining() <= 0:
            raise CodexAdapterDeadlineExceeded
        remaining = ADAPTER_TIMEOUT if deadline is None else deadline.remaining()
        await self._protocol_probe.validate(
            binary=self._binary,
            workspace=self._workspace,
            env=_filtered_environment(self._environ, self._api_key),
            timeout=remaining,
        )
        if deadline is not None and deadline.remaining() <= 0:
            raise CodexAdapterDeadlineExceeded
        self._validated_establish = True
        return report.to_mapping()

    async def prewarm(
        self,
        *,
        deadline: CodexRunDeadline | None = None,
    ) -> Mapping[str, Any] | None:
        """Establish the app-server session and thread before the first delegation (R101)."""
        async with self._prewarm_lock:
            if self._turn_in_flight or (
                self._warm and self._process is not None and self._process.returncode is None
            ):
                return None
            report = await self.preflight(deadline=deadline)
            try:
                await self._establish(deadline, on_status=None)
                probe = AppServerTurnProjection(clock=self._clock, on_progress=None)
                probe.bind_thread(self._thread_response, workspace=self._workspace)
                self._thread_id = probe.thread_id
                self._warm = True
            except BaseException:
                await self._teardown_session()
                raise
            return report

    async def _establish(
        self,
        deadline: CodexRunDeadline | None,
        *,
        on_status: Callable[[CodexProcessStatus], None] | None,
    ) -> None:
        if not self._validated_establish:
            await self.preflight(deadline=deadline)
        self._validated_establish = False
        process = await self._spawn()
        self._process = process
        if process.stdin is None or process.stdout is None or process.stderr is None:
            raise AppServerProtocolError("spawn_failed")
        if on_status is not None:
            on_status(CodexProcessStatus(running=True, exited=False))
        self._rpc = JsonRpcConnection(
            stdin=process.stdin,
            stdout=process.stdout,
            on_notification=self._on_notification,
            on_server_request=self._on_server_request,
        )
        self._rpc.start()
        self._process_wait = asyncio.create_task(process.wait())
        self._rpc_wait = asyncio.create_task(self._rpc.wait_closed())
        self._stderr_task = asyncio.create_task(_drain_stderr(process.stderr))

        await self._request(
            "initialize",
            {
                "clientInfo": {
                    "name": "nova-audio-agent",
                    "title": "Nova Audio Agent",
                    "version": "1",
                }
            },
            deadline,
        )
        self._initialized = True
        await self._notify("initialized", deadline=deadline)
        config = await self._request(
            "config/read",
            {"includeLayers": True, "cwd": str(self._workspace)},
            deadline,
        )
        validate_effective_config(config, workspace=self._workspace)
        del config
        thread_params: dict[str, Any] = {
            "ephemeral": True,
            "approvalPolicy": "never",
        }
        if self._developer_instructions is not None:
            thread_params["developerInstructions"] = self._developer_instructions
        self._thread_response = await self._request("thread/start", thread_params, deadline)

    async def run(
        self,
        work_order: str,
        *,
        on_status: Callable[[CodexProcessStatus], None],
        on_progress: Callable[[ProgressPayload], None] | None,
        deadline: CodexRunDeadline | None = None,
    ) -> CodexTransportResult:
        if self._turn_in_flight:
            return CodexTransportResult(classification="refused", code="busy", content={})
        if self._warm:
            if (
                self._process is None
                or self._process.returncode is not None
                or self._rpc is None
                or self._rpc_wait is None
                or self._rpc_wait.done()
                or self._unexpected_server_request
            ):
                # Warm state decayed: recycle and degrade to the lazy-equivalent path.
                await self._teardown_session()
            else:
                return await self._run_warm(
                    work_order,
                    on_status=on_status,
                    on_progress=on_progress,
                    deadline=deadline,
                )
        if self._process is not None:
            return CodexTransportResult(classification="refused", code="busy", content={})
        return await self._run_cold(
            work_order,
            on_status=on_status,
            on_progress=on_progress,
            deadline=deadline,
        )

    def _sanitized_progress(
        self, on_progress: Callable[[ProgressPayload], None]
    ) -> Callable[[ProgressPayload], None]:
        """R103: an emitted summary passes the terminal redaction pipeline, then re-clips.

        A sanitizer failure drops only the summary — the counters must survive."""

        def sanitized(payload: ProgressPayload) -> None:
            if payload.summary is None:
                on_progress(payload)
                return
            try:
                clean = _sanitize_final_message(
                    payload.summary,
                    workspace=self._workspace,
                    api_key=self._api_key,
                    home=self._environ.get("HOME"),
                    sensitive_inputs=tuple(self._sensitive_inputs),
                )["text"].strip()[:PROGRESS_SUMMARY_LIMIT]
            except Exception:
                on_progress(replace(payload, summary=None))
                return
            on_progress(replace(payload, summary=clean or None))

        return sanitized

    async def _run_warm(
        self,
        work_order: str,
        *,
        on_status: Callable[[CodexProcessStatus], None],
        on_progress: Callable[[ProgressPayload], None] | None,
        deadline: CodexRunDeadline | None,
    ) -> CodexTransportResult:
        self._turn_in_flight = True
        loop = asyncio.get_running_loop()
        self._completion = loop.create_future()
        self._turn_request_written = False
        self._append_sensitive(work_order)
        completion: TurnCompletion | None = None
        projection = AppServerTurnProjection(
            clock=self._clock,
            on_progress=None if on_progress is None else self._sanitized_progress(on_progress),
        )
        try:
            projection.bind_thread(self._thread_response, workspace=self._workspace)
            self._projection = projection
            on_status(CodexProcessStatus(running=True, exited=False))
            process_wait = self._process_wait
            rpc_wait = self._rpc_wait
            stderr_task = self._stderr_task
            assert process_wait is not None and rpc_wait is not None and stderr_task is not None
            await _yield_once()
            turn_response = await self._request(
                "turn/start",
                {
                    "threadId": projection.thread_id,
                    "input": [{"type": "text", "text": work_order}],
                },
                deadline,
                on_written=self._mark_turn_request_written,
                require_no_server_request=True,
            )
            projection.bind_turn_response(turn_response)
            completion = await self._wait_for_completion(
                process_wait=process_wait,
                rpc_wait=rpc_wait,
                stderr_task=stderr_task,
                deadline=deadline,
            )
            self._had_turn = True
            final_message = (
                _sanitize_final_message(
                    completion.final_text,
                    workspace=self._workspace,
                    api_key=self._api_key,
                    home=self._environ.get("HOME"),
                    sensitive_inputs=tuple(self._sensitive_inputs),
                )
                if completion.final_text is not None
                else None
            )
            clean = (
                not self._unexpected_server_request
                and completion.status == "completed"
                and completion.final_text is not None
                and self._process is not None
                and self._process.returncode is None
            )
            if clean:
                process = self._process
                stop = await self._teardown_session()
                exit_code = None if process is None else process.returncode
                classification = "completed" if exit_code == 0 and stop == "none" else "uncertain"
                code = "completed" if classification == "completed" else "nonzero_exit"
                on_status(
                    CodexProcessStatus(
                        running=exit_code is None,
                        exited=exit_code is not None,
                        terminal=(
                            "completed"
                            if classification == "completed"
                            else "failed"
                            if exit_code is not None
                            else None
                        ),
                        exit_code=exit_code,
                    )
                )
                return CodexTransportResult(
                    classification=classification,
                    code=code,
                    content=_content(
                        completion=completion,
                        exit_code=exit_code,
                        stop=stop,
                        final_message=final_message,
                    ),
                )
            # Conservative recycle: anything non-clean tears the warm session down.
            process = self._process
            stop = await self._teardown_session()
            exit_code = None if process is None else process.returncode
            on_status(
                CodexProcessStatus(
                    running=exit_code is None,
                    exited=exit_code is not None,
                    terminal="failed" if exit_code is not None else None,
                    exit_code=exit_code,
                )
            )
            if self._unexpected_server_request:
                code = "unexpected_server_request"
            elif completion.status != "completed":
                code = "turn_failed"
            elif completion.final_text is None:
                code = "missing_terminal"
            else:
                code = "nonzero_exit"
            return CodexTransportResult(
                classification="uncertain",
                code=code,
                content=_content(
                    completion=completion,
                    exit_code=exit_code,
                    stop=stop,
                    final_message=final_message,
                ),
            )
        except asyncio.CancelledError as cancelled:
            cleanup = asyncio.create_task(self._cancel_and_teardown_warm(on_status))
            while not cleanup.done():
                try:
                    await asyncio.shield(cleanup)
                except asyncio.CancelledError:
                    pass
            cleanup.result()
            raise cancelled
        except (AppServerProtocolError, CodexAdapterDeadlineExceeded) as failure:
            turn_started = projection.turn_was_started
            self._had_turn = self._had_turn or turn_started
            process = self._process
            stop = await self._teardown_session()
            exit_code = None if process is None else process.returncode
            if process is not None:
                on_status(
                    CodexProcessStatus(
                        running=exit_code is None,
                        exited=exit_code is not None,
                        terminal="failed" if exit_code is not None else None,
                        exit_code=exit_code,
                    )
                )
            code = (
                failure.code if isinstance(failure, AppServerProtocolError) else "adapter_timeout"
            )
            if not self._turn_request_written:
                return CodexTransportResult(classification="refused", code=code, content={})
            return CodexTransportResult(
                classification="uncertain",
                code=code,
                content=_content(
                    completion=completion,
                    exit_code=exit_code,
                    stop=stop,
                    final_message=None,
                    turn_started=turn_started,
                ),
            )
        except Exception:
            turn_started = projection.turn_was_started
            self._had_turn = self._had_turn or turn_started
            process = self._process
            stop = await self._teardown_session()
            exit_code = None if process is None else process.returncode
            if process is not None:
                on_status(
                    CodexProcessStatus(
                        running=exit_code is None,
                        exited=exit_code is not None,
                        terminal="failed" if exit_code is not None else None,
                        exit_code=exit_code,
                    )
                )
            if not self._turn_request_written:
                return CodexTransportResult(
                    classification="refused", code="transport_failure", content={}
                )
            return CodexTransportResult(
                classification="uncertain",
                code="transport_failure",
                content=_content(
                    completion=completion,
                    exit_code=exit_code,
                    stop=stop,
                    final_message=None,
                    turn_started=turn_started,
                ),
            )
        finally:
            self._turn_in_flight = False
            self._projection = None
            self._completion = None

    async def _run_cold(
        self,
        work_order: str,
        *,
        on_status: Callable[[CodexProcessStatus], None],
        on_progress: Callable[[ProgressPayload], None] | None,
        deadline: CodexRunDeadline | None,
    ) -> CodexTransportResult:
        self._turn_in_flight = True
        loop = asyncio.get_running_loop()
        self._completion = loop.create_future()
        self._projection = AppServerTurnProjection(
            clock=self._clock,
            on_progress=None if on_progress is None else self._sanitized_progress(on_progress),
        )
        self._initialized = False
        self._turn_request_written = False
        self._unexpected_server_request = False
        self._sensitive_inputs = [work_order]
        process_wait: asyncio.Task[int] | None = None
        rpc_wait: asyncio.Task[None] | None = None
        stderr_task: asyncio.Task[None] | None = None
        completion: TurnCompletion | None = None
        stop: Literal["none", "terminate", "kill"] = "none"
        try:
            await self._establish(deadline, on_status=on_status)
            process = self._process
            assert process is not None
            process_wait = self._process_wait
            rpc_wait = self._rpc_wait
            stderr_task = self._stderr_task
            self._projection.bind_thread(self._thread_response, workspace=self._workspace)
            # Let the sole reader drain any server request already queued directly
            # behind the thread response before the side-effecting turn write.
            await _yield_once()

            turn_response = await self._request(
                "turn/start",
                {
                    "threadId": self._projection.thread_id,
                    "input": [{"type": "text", "text": work_order}],
                },
                deadline,
                on_written=self._mark_turn_request_written,
                require_no_server_request=True,
            )
            self._projection.bind_turn_response(turn_response)
            completion = await self._wait_for_completion(
                process_wait=process_wait,
                rpc_wait=rpc_wait,
                stderr_task=stderr_task,
                deadline=deadline,
            )
            self._had_turn = self._projection.turn_was_started
            await self._close_stdin()
            exit_code = await _bounded_task(process_wait, EXIT_GRACE)
            await _bounded_task(rpc_wait, EXIT_GRACE)
            await _bounded_task(stderr_task, EXIT_GRACE)
            if self._unexpected_server_request:
                code = "unexpected_server_request"
                classification = "uncertain"
            elif completion.status != "completed":
                code = "turn_failed"
                classification = "uncertain"
            elif exit_code != 0:
                code = "nonzero_exit"
                classification = "uncertain"
            elif completion.final_text is None:
                code = "missing_terminal"
                classification = "uncertain"
            else:
                code = "completed"
                classification = "completed"
            content = _content(
                completion=completion,
                exit_code=exit_code,
                stop=stop,
                final_message=(
                    _sanitize_final_message(
                        completion.final_text,
                        workspace=self._workspace,
                        api_key=self._api_key,
                        home=self._environ.get("HOME"),
                        sensitive_inputs=tuple(self._sensitive_inputs),
                    )
                    if completion.final_text is not None
                    else None
                ),
            )
            terminal = "completed" if classification == "completed" else "failed"
            on_status(
                CodexProcessStatus(
                    running=False,
                    exited=True,
                    terminal=terminal,
                    exit_code=exit_code,
                )
            )
            return CodexTransportResult(classification=classification, code=code, content=content)
        except asyncio.CancelledError:
            stop = await self._interrupt_and_stop()
            self._report_stopped(on_status)
            raise
        except (AppServerProtocolError, CodexAdapterDeadlineExceeded) as failure:
            turn_started = self._projection is not None and self._projection.turn_was_started
            self._had_turn = self._had_turn or turn_started
            stop = await self._stop_process()
            self._report_stopped(on_status)
            code = (
                failure.code if isinstance(failure, AppServerProtocolError) else "adapter_timeout"
            )
            if not self._turn_request_written:
                return CodexTransportResult(classification="refused", code=code, content={})
            return CodexTransportResult(
                classification="uncertain",
                code=code,
                content=_content(
                    completion=completion,
                    exit_code=None if self._process is None else self._process.returncode,
                    stop=stop,
                    final_message=None,
                    turn_started=turn_started,
                ),
            )
        except Exception:
            turn_started = self._projection is not None and self._projection.turn_was_started
            self._had_turn = self._had_turn or turn_started
            stop = await self._stop_process()
            self._report_stopped(on_status)
            if not self._turn_request_written:
                return CodexTransportResult(
                    classification="refused", code="transport_failure", content={}
                )
            return CodexTransportResult(
                classification="uncertain",
                code="transport_failure",
                content=_content(
                    completion=completion,
                    exit_code=None if self._process is None else self._process.returncode,
                    stop=stop,
                    final_message=None,
                    turn_started=turn_started,
                ),
            )
        finally:
            process = self._process
            cleanup_cancelled = False
            if process is not None and _process_tree_running(process):
                cleanup = asyncio.create_task(_kill_and_reap(process))
                while not cleanup.done():
                    try:
                        await asyncio.shield(cleanup)
                    except asyncio.CancelledError:
                        cleanup_cancelled = True
                cleanup.result()
            for task in {
                rpc_wait,
                stderr_task,
                process_wait,
                self._rpc_wait,
                self._stderr_task,
                self._process_wait,
            }:
                if task is not None and not task.done():
                    task.cancel()
            self._process = None
            self._rpc = None
            self._projection = None
            self._completion = None
            self._initialized = False
            self._process_wait = None
            self._rpc_wait = None
            self._stderr_task = None
            self._warm = False
            self._validated_establish = False
            self._thread_response = None
            self._thread_id = None
            self._turn_in_flight = False
            self._sensitive_inputs.clear()
            self._finish_private_home()
            if cleanup_cancelled:
                raise asyncio.CancelledError

    async def steer(self, instruction: str) -> SteerTransportResult:
        rpc = self._rpc
        projection = self._projection
        if rpc is None or projection is None:
            return SteerTransportResult(
                code="stale_turn" if self._had_turn else "no_active_turn",
                written=False,
            )
        written = False
        expected_turn: str | None = None

        def prepare() -> Mapping[str, Any]:
            nonlocal expected_turn
            pair = projection.active_pair
            if pair is None:
                raise AppServerProtocolError("stale_turn")
            thread_id, turn_id = pair
            expected_turn = turn_id
            return {
                "threadId": thread_id,
                "expectedTurnId": turn_id,
                "input": [{"type": "text", "text": instruction}],
            }

        def mark_written() -> None:
            nonlocal written
            written = True
            self._append_sensitive(instruction)

        try:
            response = await rpc.request_prepared(
                "turn/steer",
                prepare,
                on_written=mark_written,
            )
        except AppServerRequestRejected as failure:
            return SteerTransportResult(
                code="stale_turn" if failure.server_code == -32602 else "server_rejected",
                written=written,
            )
        except AppServerProtocolError as failure:
            if not written and failure.code == "stale_turn":
                return SteerTransportResult(code="stale_turn", written=False)
            return SteerTransportResult(
                code="transport_lost" if written else "stale_turn",
                written=written,
            )
        try:
            if type(response) is not dict or response.get("turnId") != expected_turn:
                return SteerTransportResult(code="server_rejected", written=True)
        except Exception:
            return SteerTransportResult(code="server_rejected", written=True)
        return SteerTransportResult(code="accepted", written=True)

    async def shutdown(self) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """Session-level teardown: interrupt any active turn, reap the process, wipe the home."""
        await self._interrupt_and_stop()
        await self._teardown_session()

    async def _teardown_session(self) -> Literal["none", "terminate", "kill"]:
        stop = await self._stop_process()
        process = self._process
        if process is not None and _process_tree_running(process):
            await _kill_and_reap(process)
        for task in (self._rpc_wait, self._stderr_task, self._process_wait):
            if task is not None and not task.done():
                task.cancel()
        self._process_wait = None
        self._rpc_wait = None
        self._stderr_task = None
        self._process = None
        self._rpc = None
        self._initialized = False
        self._warm = False
        self._validated_establish = False
        self._thread_response = None
        self._thread_id = None
        self._sensitive_inputs.clear()
        self._finish_private_home()
        return stop

    async def _cancel_and_teardown_warm(
        self,
        on_status: Callable[[CodexProcessStatus], None],
    ) -> None:
        try:
            await self._interrupt_and_stop()
            self._report_stopped(on_status)
        finally:
            await self._teardown_session()

    def _append_sensitive(self, text: str) -> None:
        """Retain the active work order and same-turn steers until final redaction."""
        self._sensitive_inputs.append(text)

    async def _spawn(self) -> _Process:
        env = _filtered_environment(self._environ, self._api_key)
        private_home = tempfile.TemporaryDirectory(prefix="nova-audio-agent-codex-live-")
        self._private_home = private_home
        private_home_path = Path(private_home.name)
        if self._api_key is None:
            source_home = Path(
                self._environ.get(
                    "CODEX_HOME",
                    str(Path(self._environ.get("HOME", str(Path.home()))) / ".codex"),
                )
            )
            for name in ("auth.json", ".credentials.json"):
                source = source_home / name
                if not source.is_file():
                    continue
                destination = private_home_path / name
                try:
                    shutil.copyfile(source, destination)
                    destination.chmod(0o600)
                except OSError:
                    self._finish_private_home()
                    raise AppServerProtocolError("credential_missing") from None
        env["CODEX_HOME"] = str(private_home_path)
        env["CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED"] = "1"
        return await self._process_factory(
            self._binary,
            *CODEX_ROOT_OVERRIDES,
            *LIVE_APP_SERVER_OPTIONS,
            cwd=self._workspace,
            env=env,
            start_new_session=os.name == "posix",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=MAX_JSONL_LINE + 1,
        )

    def _finish_private_home(self) -> None:
        private_home = self._private_home
        if private_home is None:
            return
        path = Path(private_home.name)
        if self._home_observer is not None:
            try:
                self._home_observer(path)
            except Exception:
                pass
        private_home.cleanup()
        self._private_home = None

    async def _request(
        self,
        method: str,
        params: Mapping[str, Any],
        deadline: CodexRunDeadline | None,
        *,
        on_written: Callable[[], None] | None = None,
        require_no_server_request: bool = False,
    ) -> Any:
        assert self._rpc is not None

        def prepare() -> Mapping[str, Any]:
            if require_no_server_request and self._unexpected_server_request:
                raise AppServerProtocolError("unsupported_protocol")
            return params

        awaitable = self._rpc.request_prepared(
            method,
            prepare,
            on_written=on_written,
        )
        result = await _with_deadline(awaitable, deadline)
        if self._unexpected_server_request and not self._turn_request_written:
            raise AppServerProtocolError("unsupported_protocol")
        return result

    def _mark_turn_request_written(self) -> None:
        self._turn_request_written = True

    def _report_stopped(
        self,
        on_status: Callable[[CodexProcessStatus], None],
    ) -> None:
        process = self._process
        if process is None:
            return
        exit_code = process.returncode
        on_status(
            CodexProcessStatus(
                running=exit_code is None,
                exited=exit_code is not None,
                terminal="failed" if exit_code is not None else None,
                exit_code=exit_code,
            )
        )

    async def _notify(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
        *,
        deadline: CodexRunDeadline | None,
    ) -> None:
        assert self._rpc is not None
        await _with_deadline(self._rpc.notify(method, params), deadline)

    def _on_notification(self, item: tuple[str, dict[str, Any]]) -> None:
        if not self._initialized or self._projection is None:
            return
        method, params = item
        if self._notification_observer is not None:
            try:
                item_types: tuple[str, ...] = ()
                if method == "item/completed" and type(params.get("item")) is dict:
                    item_type = params["item"].get("type")
                    if type(item_type) is str:
                        item_types = (item_type,)
                elif method == "turn/completed" and type(params.get("turn")) is dict:
                    turn = params["turn"]
                    items = turn.get("items")
                    if type(items) is list:
                        item_types = tuple(
                            item["type"]
                            for item in items
                            if type(item) is dict and type(item.get("type")) is str
                        )
                    items_view = turn.get("itemsView")
                    if type(items_view) is str:
                        item_types = (*item_types, f"itemsView:{items_view}")
                self._notification_observer(method, item_types)
            except Exception:
                pass
        completion = self._projection.notification(method, params)
        if completion is not None and self._completion is not None and not self._completion.done():
            self._completion.set_result(completion)

    def _on_server_request(self, _method: str) -> None:
        self._unexpected_server_request = True

    async def _wait_for_completion(
        self,
        *,
        process_wait: asyncio.Task[int],
        rpc_wait: asyncio.Task[None],
        stderr_task: asyncio.Task[None],
        deadline: CodexRunDeadline | None,
    ) -> TurnCompletion:
        assert self._completion is not None
        waiters: set[asyncio.Future[Any] | asyncio.Task[Any]] = {
            self._completion,
            process_wait,
            rpc_wait,
            stderr_task,
        }
        while waiters:
            timeout = None if deadline is None else deadline.remaining()
            done, waiters = await asyncio.wait(
                waiters,
                timeout=timeout,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if self._completion in done:
                return self._completion.result()
            if not done:
                raise CodexAdapterDeadlineExceeded
            for task in done:
                if task is stderr_task:
                    task.result()
                    continue
                if task is rpc_wait:
                    task.result()
                raise AppServerProtocolError("missing_terminal")
        raise AppServerProtocolError("missing_terminal")

    async def _close_stdin(self) -> None:
        process = self._process
        if process is None or process.stdin is None:
            return
        process.stdin.close()
        try:
            await process.stdin.wait_closed()
        except (AttributeError, ConnectionError, OSError):
            pass

    async def _interrupt_and_stop(self) -> Literal["none", "terminate", "kill"]:
        rpc = self._rpc
        projection = self._projection
        if rpc is not None and projection is not None and projection.active_pair is not None:
            thread_id, turn_id = projection.active_pair
            try:
                async with asyncio.timeout(INTERRUPT_GRACE):
                    await rpc.request(
                        "turn/interrupt",
                        {"threadId": thread_id, "turnId": turn_id},
                    )
                    completion = self._completion
                    if completion is not None and not completion.done():
                        await asyncio.shield(completion)
            except Exception:
                pass
        return await self._stop_process()

    async def _stop_process(self) -> Literal["none", "terminate", "kill"]:
        process = self._process
        if process is None:
            return "none"
        await self._close_stdin()
        try:
            async with asyncio.timeout(EXIT_GRACE):
                await _wait_process_tree(process)
            return "none"
        except TimeoutError:
            _terminate_process(process)
        try:
            async with asyncio.timeout(EXIT_GRACE):
                await _wait_process_tree(process)
            return "terminate"
        except TimeoutError:
            _kill_process(process)
            try:
                async with asyncio.timeout(EXIT_GRACE):
                    await _wait_process_tree(process)
            except TimeoutError:
                pass
            return "kill"


async def _kill_and_reap(process: _Process) -> None:
    _kill_process(process)
    try:
        async with asyncio.timeout(EXIT_GRACE):
            await _wait_process_tree(process)
    except TimeoutError:
        pass


async def _wait_process_tree(process: _Process) -> None:
    if process.returncode is None:
        await process.wait()
    clock = RealClock()
    while _process_tree_running(process):
        await clock.sleep(PROCESS_TREE_POLL_INTERVAL)


def _process_tree_running(process: _Process) -> bool:
    if os.name == "posix" and isinstance(process, asyncio.subprocess.Process):
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True
    return process.returncode is None


def _terminate_process(process: _Process) -> None:
    _signal_process_group(process, signal.SIGTERM, process.terminate)


def _kill_process(process: _Process) -> None:
    _signal_process_group(process, signal.SIGKILL, process.kill)


def _signal_process_group(
    process: _Process,
    sig: signal.Signals,
    fallback: Callable[[], None],
) -> None:
    if os.name == "posix" and isinstance(process, asyncio.subprocess.Process):
        try:
            os.killpg(process.pid, sig)
            return
        except OSError:
            pass
    try:
        fallback()
    except ProcessLookupError:
        pass


async def _with_deadline(awaitable: Awaitable[Any], deadline: CodexRunDeadline | None) -> Any:
    if deadline is None:
        return await awaitable
    remaining = deadline.remaining()
    if remaining <= 0:
        if asyncio.iscoroutine(awaitable):
            awaitable.close()
        raise CodexAdapterDeadlineExceeded
    if isinstance(deadline.clock, RealClock):
        try:
            async with asyncio.timeout(remaining):
                return await awaitable
        except TimeoutError:
            raise CodexAdapterDeadlineExceeded from None
    result = await awaitable
    if deadline.remaining() <= 0:
        raise CodexAdapterDeadlineExceeded
    return result


async def _yield_once() -> None:
    future = asyncio.get_running_loop().create_future()
    asyncio.get_running_loop().call_soon(future.set_result, None)
    await future


async def _bounded_task(task: asyncio.Task[Any], timeout: float) -> Any:
    try:
        async with asyncio.timeout(timeout):
            return await asyncio.shield(task)
    except TimeoutError:
        raise AppServerProtocolError("transport_lost") from None


async def _drain_stderr(stream: asyncio.StreamReader) -> None:
    total = 0
    while True:
        chunk = await stream.read(min(64 * 1024, STDERR_LIMIT - total + 1))
        if not chunk:
            return
        total += len(chunk)
        if total > STDERR_LIMIT:
            raise AppServerProtocolError("stderr_too_large")


def _bounded_developer_instructions(value: str | None) -> str | None:
    if value is None:
        return None
    if type(value) is not str:
        raise ValueError("developer_instructions must be a string")
    normalized = value.strip()
    if not normalized or len(normalized) > 4000:
        raise ValueError("developer_instructions must be 1..4000 characters")
    return normalized


def _sanitize_final_message(
    text: str,
    *,
    workspace: Path,
    api_key: str | None,
    home: str | None,
    sensitive_inputs: tuple[str, ...] = (),
) -> dict[str, Any]:
    normalized = unicodedata.normalize("NFC", text[:FINAL_INPUT_LIMIT])
    normalized_inputs = tuple(
        unicodedata.normalize("NFC", item) for item in sensitive_inputs if item
    )
    for secret in (
        *sorted(normalized_inputs, key=len, reverse=True),
        api_key,
        str(workspace),
        home,
    ):
        if secret:
            normalized = normalized.replace(secret, "[REDACTED]")
    normalized = _PRIVATE_KEY.sub("[PRIVATE_KEY]", normalized)
    normalized = _CREDENTIAL.sub("[REDACTED]", normalized)
    normalized = "".join(
        " " if unicodedata.category(char).startswith("C") else char for char in normalized
    )
    retained = normalized[:FINAL_TEXT_LIMIT]
    return {
        "text": retained,
        "original_chars": len(normalized),
        "truncated": len(normalized) > FINAL_TEXT_LIMIT,
        "sha256": hashlib.sha256(normalized.encode("utf-8")).hexdigest(),
    }


def _content(
    *,
    completion: TurnCompletion | None,
    exit_code: int | None,
    stop: str,
    final_message: Mapping[str, Any] | None,
    turn_started: bool = True,
    transport_closed: bool = True,
) -> dict[str, Any]:
    terminal = None if completion is None else completion.status
    activity = 0 if completion is None else completion.internal_activity
    events: list[dict[str, Any]] = []
    if turn_started:
        events.extend(({"type": "thread.started"}, {"type": "turn.started"}))
        if activity:
            events.append({"type": "internal_activity", "count": activity})
        if terminal is not None:
            events.append({"type": f"turn.{terminal}"})
    content: dict[str, Any] = {
        "events": events,
        "protocol": {
            "thread_started": turn_started,
            "turn_started": turn_started,
            "terminal": terminal,
            "transport_closed": transport_closed,
            "unknown_event_count": 0,
        },
        "process": {"started": True, "exit_code": exit_code, "stop": stop},
    }
    if final_message is not None:
        content["result"] = {"final_message": dict(final_message)}
    return content
