from __future__ import annotations

import asyncio
import json
import signal
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from nova_audio_agent.clock import RealClock, VirtualClock
from nova_audio_agent.executors.autoglm_protocol import MAX_LINE_BYTES
from nova_audio_agent.executors.autoglm_transport import (
    MAX_STDERR_BYTES,
    AutoGlmTransport,
    AutoGlmTransportFailure,
)
from nova_audio_agent.executors import autoglm_transport


API_KEY = "autoglm-test-secret"


@dataclass(frozen=True)
class _Deadline:
    expires_at: float
    clock: object

    def remaining(self) -> float:
        return max(0.0, self.expires_at - self.clock.now())  # type: ignore[attr-defined]


def _deadline(after: float) -> _Deadline:
    clock = RealClock()
    return _Deadline(clock.now() + after, clock)


def _stream(payload: bytes) -> asyncio.StreamReader:
    stream = asyncio.StreamReader()
    stream.feed_data(payload)
    stream.feed_eof()
    return stream


def _result(outcome: str = "completed", code: str = "completed") -> bytes:
    return (
        json.dumps(
            {
                "type": "result",
                "outcome": outcome,
                "code": code,
                "effect_verification": "not_performed",
            },
            separators=(",", ":"),
        )
        + "\n"
    ).encode()


def _status(state: str) -> bytes:
    return (json.dumps({"type": "status", "state": state}, separators=(",", ":")) + "\n").encode()


class _FakeProcess:
    def __init__(
        self,
        *,
        stdout: bytes = _result(),
        stderr: bytes = b"",
        returncode: int = 0,
        ignore_terminate: bool = False,
    ) -> None:
        self.stdout = _stream(stdout)
        self.stderr = _stream(stderr)
        self.returncode: int | None = None
        self.pid: int | None = None
        self._configured_returncode = returncode
        self._ignore_terminate = ignore_terminate
        self._stopped = asyncio.Event()
        if stdout != b"":
            self._stopped.set()
        self.terminate_calls = 0
        self.kill_calls = 0

    async def wait(self) -> int:
        await self._stopped.wait()
        if self.returncode is None:
            self.returncode = self._configured_returncode
        return self.returncode

    def terminate(self) -> None:
        self.terminate_calls += 1
        if not self._ignore_terminate:
            self.returncode = -15
            self._stopped.set()

    def kill(self) -> None:
        self.kill_calls += 1
        self.returncode = -9
        self._stopped.set()


class _ProcessFactory:
    def __init__(self, process: _FakeProcess) -> None:
        self.process = process
        self.calls: list[tuple[tuple[str, ...], dict[str, Any]]] = []

    async def __call__(self, *argv: str, **kwargs: Any) -> _FakeProcess:
        self.calls.append((argv, kwargs))
        return self.process


class _NeverFactory:
    def __init__(self) -> None:
        self.calls: list[tuple[tuple[str, ...], dict[str, Any]]] = []

    async def __call__(self, *argv: str, **kwargs: Any) -> _FakeProcess:
        self.calls.append((argv, kwargs))
        raise AssertionError("must not spawn")


class _FailingFactory:
    def __init__(self, failure: BaseException) -> None:
        self.failure = failure
        self.calls = 0

    async def __call__(self, *_argv: str, **_kwargs: Any) -> _FakeProcess:
        self.calls += 1
        raise self.failure


def _transport(factory: _ProcessFactory, **kwargs: object) -> AutoGlmTransport:
    return AutoGlmTransport(
        runner_path=Path("/runner/autoglm_ios_runner.py"),
        external_python="/venv/bin/python",
        repo=Path("/repo/Open-AutoGLM"),
        model_endpoint="https://open.bigmodel.cn/api/paas/v4",
        model_name="autoglm-phone",
        api_key=API_KEY,
        wda_url="http://127.0.0.1:8100",
        device_id="device-1",
        process_factory=factory,
        environ={"PATH": "/usr/bin", "UNRELATED_SECRET": "not-the-api-key"},
        **kwargs,
    )


@pytest.mark.parametrize(
    "url",
    (
        "https://127.0.0.1:8100",
        "http://127.0.0.1:8101",
        "http://example.com:8100",
        "http://user@localhost:8100",
        "http://localhost:8100/",
        "http://localhost:8100/wda",
        "http://localhost:8100?redirect=example.com",
        "http://localhost:8100#fragment",
    ),
)
def test_transport_rejects_non_exact_loopback_wda_url_without_spawning(url: str) -> None:
    factory = _NeverFactory()

    with pytest.raises(ValueError, match="invalid_wda_url"):
        AutoGlmTransport(
            runner_path=Path("/runner/autoglm_ios_runner.py"),
            external_python="/venv/bin/python",
            repo=Path("/repo/Open-AutoGLM"),
            model_endpoint="https://open.bigmodel.cn/api/paas/v4",
            model_name="autoglm-phone",
            api_key=API_KEY,
            wda_url=url,
            device_id=None,
            process_factory=factory,
        )

    assert factory.calls == []


@pytest.mark.asyncio
async def test_run_browse_passes_credentials_only_through_worker_environment() -> None:
    factory = _ProcessFactory(_FakeProcess())
    transport = _transport(factory)

    result = await transport.run_browse("weather in Shanghai", deadline=_deadline(20))

    assert result.outcome == "completed"
    assert len(factory.calls) == 1
    argv, kwargs = factory.calls[0]
    assert argv == (
        "/venv/bin/python",
        "/runner/autoglm_ios_runner.py",
        "--repo",
        "/repo/Open-AutoGLM",
        "--base-url",
        "https://open.bigmodel.cn/api/paas/v4",
        "--model",
        "autoglm-phone",
        "--wda-url",
        "http://127.0.0.1:8100",
        "--device-id",
        "device-1",
        "--max-steps",
        "20",
    )
    assert API_KEY not in repr(argv)
    assert "weather in Shanghai" not in repr(argv)
    assert kwargs["cwd"] == Path("/repo/Open-AutoGLM")
    assert kwargs["env"]["NOVA_AUDIO_AGENT_AUTOGLM_API_KEY"] == API_KEY
    assert kwargs["env"]["NOVA_AUDIO_AGENT_AUTOGLM_QUERY"] == "weather in Shanghai"
    assert "UNRELATED_SECRET" not in kwargs["env"]
    assert kwargs["start_new_session"] is (autoglm_transport.os.name == "posix")


@pytest.mark.asyncio
async def test_run_browse_uses_the_deadlines_own_real_clock_basis() -> None:
    factory = _ProcessFactory(_FakeProcess())

    class _OffsetRealClock(RealClock):
        def now(self) -> float:
            return super().now() - 10_000.0

    clock = _OffsetRealClock()

    result = await _transport(factory).run_browse(
        "weather",
        deadline=_Deadline(expires_at=clock.now() + 20.0, clock=clock),
    )

    assert result.outcome == "completed"
    assert len(factory.calls) == 1


@pytest.mark.asyncio
async def test_run_browse_rejects_virtual_clock_before_spawning() -> None:
    factory = _ProcessFactory(_FakeProcess())

    with pytest.raises(AutoGlmTransportFailure, match="clock_mismatch") as raised:
        await _transport(factory).run_browse(
            "weather",
            deadline=_Deadline(expires_at=21.0, clock=VirtualClock(start=1.0)),
        )

    assert raised.value.worker_started is False
    assert factory.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("stdout", "stderr", "code"),
    [
        (b"x" * (MAX_LINE_BYTES + 1), b"", "line_too_large"),
        (_result(), b"x" * (MAX_STDERR_BYTES + 1), "stderr_too_large"),
    ],
)
async def test_run_browse_rejects_oversized_worker_streams(
    stdout: bytes, stderr: bytes, code: str
) -> None:
    factory = _ProcessFactory(_FakeProcess(stdout=stdout, stderr=stderr))

    with pytest.raises(AutoGlmTransportFailure, match=code):
        await _transport(factory).run_browse("weather", deadline=_deadline(20))

    assert len(factory.calls) == 1


@pytest.mark.asyncio
async def test_run_browse_reports_abnormal_exit_without_a_retry() -> None:
    factory = _ProcessFactory(_FakeProcess(returncode=7))

    with pytest.raises(AutoGlmTransportFailure, match="nonzero_exit"):
        await _transport(factory).run_browse("weather", deadline=_deadline(20))

    assert len(factory.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(("returncode", "expected"), ((0, None), (7, "nonzero_exit")))
async def test_run_browse_cleans_residual_process_group_after_stdio_eof(
    monkeypatch: pytest.MonkeyPatch,
    returncode: int,
    expected: str | None,
) -> None:
    process = _FakeProcess(returncode=returncode)
    process.pid = 6543
    factory = _ProcessFactory(process)
    signals: list[signal.Signals | int] = []
    group_alive = True

    def killpg(pid: int, selected_signal: signal.Signals | int) -> None:
        nonlocal group_alive
        assert pid == process.pid
        signals.append(selected_signal)
        if selected_signal == signal.SIGTERM:
            group_alive = False
        elif selected_signal == 0 and not group_alive:
            raise ProcessLookupError

    monkeypatch.setattr(autoglm_transport.os, "killpg", killpg)

    if expected is None:
        result = await _transport(factory).run_browse("weather", deadline=_deadline(20))
        assert result.outcome == "completed"
    else:
        with pytest.raises(AutoGlmTransportFailure, match=expected):
            await _transport(factory).run_browse("weather", deadline=_deadline(20))

    assert signals == [0, signal.SIGTERM, 0]


@pytest.mark.asyncio
async def test_run_browse_never_returns_success_while_descendants_survive_kill(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = _FakeProcess()
    process.pid = 6544
    signals: list[signal.Signals | int] = []

    def killpg(pid: int, selected_signal: signal.Signals | int) -> None:
        assert pid == process.pid
        signals.append(selected_signal)

    monkeypatch.setattr(autoglm_transport.os, "killpg", killpg)

    with pytest.raises(AutoGlmTransportFailure, match="transport_failure"):
        await _transport(_ProcessFactory(process), _terminate_grace=0.001).run_browse(
            "weather", deadline=_deadline(1)
        )

    assert signal.SIGTERM in signals
    assert signal.SIGKILL in signals
    assert signals[-1] == 0


@pytest.mark.asyncio
async def test_run_browse_timeout_terminates_the_started_worker() -> None:
    factory = _ProcessFactory(_FakeProcess(stdout=b""))
    transport = _transport(factory, _terminate_grace=0.001)

    with pytest.raises(AutoGlmTransportFailure, match="timeout") as raised:
        await transport.run_browse("weather", deadline=_deadline(0.01))

    assert raised.value.worker_started is True
    assert factory.process.terminate_calls == 1
    assert factory.process.kill_calls == 0


@pytest.mark.asyncio
async def test_run_browse_kills_a_worker_that_ignores_termination() -> None:
    factory = _ProcessFactory(_FakeProcess(stdout=b"", ignore_terminate=True))
    transport = _transport(factory, _terminate_grace=0.001)

    with pytest.raises(AutoGlmTransportFailure, match="timeout"):
        await transport.run_browse("weather", deadline=_deadline(0.01))

    assert factory.process.terminate_calls == 1
    assert factory.process.kill_calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("stdout", "stderr"),
    [
        (_status(API_KEY), b""),
        (_result(code=API_KEY), b""),
        (_result(), b"worker echoed " + API_KEY.encode()),
    ],
)
async def test_run_browse_rejects_configured_key_in_any_worker_output(
    stdout: bytes, stderr: bytes
) -> None:
    factory = _ProcessFactory(_FakeProcess(stdout=stdout, stderr=stderr))

    with pytest.raises(AutoGlmTransportFailure, match="credential_output") as raised:
        await _transport(factory).run_browse("weather", deadline=_deadline(20))

    assert API_KEY not in str(raised.value)


@pytest.mark.asyncio
async def test_run_browse_refuses_before_spawning_without_cleanup_reserve() -> None:
    factory = _ProcessFactory(_FakeProcess())
    transport = _transport(factory, _terminate_grace=0.01)

    with pytest.raises(AutoGlmTransportFailure, match="timeout") as raised:
        await transport.run_browse("weather", deadline=_deadline(0.01))

    assert raised.value.worker_started is False
    assert factory.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("failure", "worker_started"),
    ((OSError("missing runner"), False), (RuntimeError("uncertain spawn"), True)),
)
async def test_run_browse_classifies_spawn_failures_conservatively(
    failure: BaseException,
    worker_started: bool,
) -> None:
    factory = _FailingFactory(failure)
    transport = AutoGlmTransport(
        runner_path=Path("/runner/autoglm_ios_runner.py"),
        external_python="/venv/bin/python",
        repo=Path("/repo/Open-AutoGLM"),
        model_endpoint="https://open.bigmodel.cn/api/paas/v4",
        model_name="autoglm-phone",
        api_key=API_KEY,
        wda_url="http://127.0.0.1:8100",
        device_id=None,
        process_factory=factory,
    )

    with pytest.raises(AutoGlmTransportFailure, match="spawn_failed") as raised:
        await transport.run_browse("weather", deadline=_deadline(20))

    assert raised.value.worker_started is worker_started
    assert factory.calls == 1


@pytest.mark.asyncio
async def test_run_browse_bounds_subprocess_creation_by_the_absolute_deadline() -> None:
    started = asyncio.Event()

    class _HangingFactory:
        calls = 0

        async def __call__(self, *_argv: str, **_kwargs: Any) -> _FakeProcess:
            self.calls += 1
            started.set()
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

    factory = _HangingFactory()
    transport = _transport(factory, _terminate_grace=0.001)

    with pytest.raises(AutoGlmTransportFailure, match="timeout") as raised:
        await asyncio.wait_for(
            transport.run_browse("weather", deadline=_deadline(0.01)),
            timeout=0.1,
        )

    # The subprocess factory timed out before returning a handle. A child may still
    # have crossed the spawn boundary, so this path must remain conservative.
    assert raised.value.worker_started is True
    assert started.is_set()
    assert factory.calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_type", (KeyboardInterrupt, SystemExit))
async def test_run_browse_reraises_control_flow_from_gather_stage(
    monkeypatch: pytest.MonkeyPatch,
    failure_type: type[BaseException],
) -> None:
    process = _FakeProcess()
    real_gather = asyncio.gather
    calls = 0

    def interrupt_first_gather(*aws: object, **kwargs: object) -> object:
        nonlocal calls
        calls += 1
        if calls == 1:
            for task in aws:
                task.cancel()  # type: ignore[attr-defined]
            raise failure_type
        return real_gather(*aws, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(asyncio, "gather", interrupt_first_gather)

    with pytest.raises(failure_type):
        await _transport(_ProcessFactory(process)).run_browse(
            "weather",
            deadline=_deadline(20),
        )

    assert process.terminate_calls == 1
    assert calls == 2


@pytest.mark.asyncio
async def test_run_browse_kills_the_process_group_after_its_leader_exits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = _FakeProcess(stdout=b"")
    process.pid = 9876
    factory = _ProcessFactory(process)
    signals: list[signal.Signals | int] = []
    group_alive = True

    def killpg(pid: int, selected_signal: signal.Signals | int) -> None:
        nonlocal group_alive
        assert pid == process.pid
        signals.append(selected_signal)
        if selected_signal == signal.SIGTERM:
            process.returncode = -15
            process._stopped.set()
        elif selected_signal == signal.SIGKILL:
            group_alive = False
        elif selected_signal == 0 and not group_alive:
            raise ProcessLookupError

    monkeypatch.setattr(autoglm_transport.os, "killpg", killpg)
    transport = _transport(factory, _terminate_grace=0.001)

    with pytest.raises(AutoGlmTransportFailure, match="timeout"):
        await transport.run_browse("weather", deadline=_deadline(0.01))

    kill_index = signals.index(signal.SIGKILL)
    assert signals[0] == signal.SIGTERM
    assert signals[1:kill_index]
    assert all(selected_signal == 0 for selected_signal in signals[1:kill_index])
    assert signals[kill_index:] == [signal.SIGKILL, 0]
    assert process.terminate_calls == 0
    assert process.kill_calls == 0


@pytest.mark.asyncio
async def test_stop_polls_for_descendant_group_exit_before_escalating_to_kill(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = _FakeProcess(stdout=b"")
    process.pid = 8765
    signals: list[signal.Signals | int] = []
    group_alive = True

    def killpg(pid: int, selected_signal: signal.Signals | int) -> None:
        nonlocal group_alive
        assert pid == process.pid
        signals.append(selected_signal)
        if selected_signal == signal.SIGTERM:
            process.returncode = -15
            process._stopped.set()
        elif selected_signal == signal.SIGKILL:
            group_alive = False
        elif selected_signal == 0 and not group_alive:
            raise ProcessLookupError

    monkeypatch.setattr(autoglm_transport.os, "killpg", killpg)
    transport = _transport(_ProcessFactory(process), _terminate_grace=0.003)

    assert await transport._stop(process) is True

    kill_index = signals.index(signal.SIGKILL)
    assert signals[:kill_index].count(0) >= 2
    assert signals[-1] == 0


@pytest.mark.asyncio
async def test_stop_reports_a_group_that_survives_sigkill(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = _FakeProcess(stdout=b"")
    process.pid = 7654
    signals: list[signal.Signals | int] = []

    def killpg(pid: int, selected_signal: signal.Signals | int) -> None:
        assert pid == process.pid
        signals.append(selected_signal)
        if selected_signal == signal.SIGTERM:
            process.returncode = -15
            process._stopped.set()

    monkeypatch.setattr(autoglm_transport.os, "killpg", killpg)
    transport = _transport(_ProcessFactory(process), _terminate_grace=0.001)

    assert await transport._stop(process) is False
    assert signal.SIGKILL in signals
    assert signals[-1] == 0
