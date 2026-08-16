from __future__ import annotations

from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Callable

import pytest

from nova_audio_agent.executors.codex import CodexProcessStatus
from nova_audio_agent.ports import Handoff
from scripts import smoke_codex


PREFLIGHT_REPORT = {
    "version": "0.145.0",
    "root_matches": True,
    "mount": "workspace_only",
    "subprocess": "contained",
    "network": "blocked",
    "credential": {"present": True, "identity": "chatgpt", "policy": "saved_login"},
    "limits": {"cpu": "finite", "as": "unbounded", "nofile": "unavailable"},
}


class _Settings:
    def __init__(
        self, workspace: Path, *, api_key: str | None = None, error: Exception | None = None
    ) -> None:
        self.workspace = workspace
        self.api_key = api_key
        self.error = error
        self.calls = 0

    def require_codex(self) -> tuple[Path, str, str | None]:
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.workspace, "codex-test", self.api_key


class _Transport:
    def __init__(
        self, report: object = PREFLIGHT_REPORT, *, error: Exception | None = None
    ) -> None:
        self.report = report
        self.error = error
        self.preflight_calls = 0

    async def preflight(self) -> object:
        self.preflight_calls += 1
        if self.error is not None:
            raise self.error
        return self.report


@dataclass
class _Adapter:
    repository: Path
    observe_running: bool = True
    create_file: bool = True
    file_bytes: bytes = smoke_codex.SMOKE_BYTES
    completed: bool = True
    protocol_terminal: str = "completed"
    transport_closed: bool = True
    exit_code: int = 0
    process_exited: bool = True
    status: object = field(
        default_factory=lambda: SimpleNamespace(
            process_running=False,
            process_exited=False,
            terminal=None,
            exit_code=None,
        )
    )
    work_order: str | None = None

    async def dispatch(self, op: str, request: dict[str, str], _: object) -> Handoff:
        assert op == "run"
        self.work_order = request["work_order"]
        if self.observe_running:
            self.status = CodexProcessStatus(running=True, exited=False)
        await smoke_codex.RealClock().sleep(0)
        if self.create_file:
            (self.repository / smoke_codex.SMOKE_FILE).write_bytes(self.file_bytes)
        self.status = SimpleNamespace(
            process_running=False,
            process_exited=self.process_exited,
            terminal="completed" if self.completed else "failed",
            exit_code=self.exit_code,
        )
        return Handoff(
            outcome="ok" if self.completed else "unknown",
            trust="untrusted_external",
            content={
                "code": "completed" if self.completed else "nonzero_exit",
                "protocol": {
                    "terminal": self.protocol_terminal,
                    "transport_closed": self.transport_closed,
                },
            },
        )


class _TemporaryDirectory(AbstractContextManager[str]):
    def __init__(
        self,
        path: Path,
        *,
        enter_error: Exception | None = None,
        cleanup_error: Exception | None = None,
    ) -> None:
        self.path = path
        self.enter_error = enter_error
        self.cleanup_error = cleanup_error

    def __enter__(self) -> str:
        if self.enter_error is not None:
            raise self.enter_error
        self.path.mkdir()
        return str(self.path)

    def __exit__(self, *_: object) -> None:
        if self.cleanup_error is not None:
            raise self.cleanup_error


def _git_init(
    calls: list[tuple[str, ...]], *, error: Exception | None = None
) -> Callable[[Path], None]:
    def run(repository: Path) -> None:
        if error is not None:
            raise error
        calls.append(("git", "init", str(repository)))
        (repository / ".git").mkdir()

    return run


def _safe_temp_root(tmp_path: Path) -> Path:
    root = tmp_path / "system-temp"
    root.mkdir()
    return root


def _apply_kwargs(tmp_path: Path, **overrides: object) -> dict[str, object]:
    production = tmp_path / "production"
    production.mkdir()
    temporary = tmp_path / "temporary"
    return {
        "apply": True,
        "settings": _Settings(production),
        "transport_factory": lambda *_: _Transport(),
        "adapter_factory": lambda _, repository: _Adapter(repository),
        "temporary_directory": lambda: _TemporaryDirectory(temporary),
        "temporary_root": lambda: _safe_temp_root(tmp_path),
        "git_init": _git_init([]),
        **overrides,
    }


@pytest.mark.asyncio
async def test_default_mode_runs_preflight_only_and_emits_safe_evidence(tmp_path: Path) -> None:
    production = tmp_path / "production"
    production.mkdir()
    settings = _Settings(production)
    transport = _Transport()
    output: list[str] = []
    factory_calls: list[Path] = []

    result = await smoke_codex.run_smoke(
        apply=False,
        settings=settings,
        transport_factory=lambda _binary, workspace, _key: (
            factory_calls.append(workspace) or transport
        ),
        emit=output.append,
    )

    assert result == 0
    assert settings.calls == 1
    assert factory_calls == [production]
    assert transport.preflight_calls == 1
    assert output == [
        "Codex preflight passed: version=0.145.0 credential=chatgpt/saved_login "
        "root=matched write=workspace_only child=contained network=blocked "
        "limits=cpu:finite,as:unbounded,nofile:unavailable"
    ]


@pytest.mark.asyncio
async def test_default_mode_rejects_non_whitelisted_preflight_data(tmp_path: Path) -> None:
    output: list[str] = []
    result = await smoke_codex.run_smoke(
        apply=False,
        settings=_Settings(tmp_path),
        transport_factory=lambda *_: _Transport({"version": "/private/raw-output"}),
        emit=output.append,
    )

    assert result == 1
    assert output == ["Codex smoke failed"]


@pytest.mark.asyncio
async def test_apply_constructs_transport_with_disjoint_temporary_repository(
    tmp_path: Path,
) -> None:
    production = tmp_path / "production"
    production.mkdir()
    temporary = tmp_path / "temporary"
    seen_workspaces: list[Path] = []
    adapter: _Adapter | None = None

    def transport_factory(_binary: str, workspace: Path, _key: str | None) -> _Transport:
        seen_workspaces.append(workspace)
        return _Transport()

    def adapter_factory(_: object, repository: Path) -> _Adapter:
        nonlocal adapter
        adapter = _Adapter(repository)
        return adapter

    result = await smoke_codex.run_smoke(
        apply=True,
        settings=_Settings(production),
        transport_factory=transport_factory,
        adapter_factory=adapter_factory,
        temporary_directory=lambda: _TemporaryDirectory(temporary),
        temporary_root=lambda: _safe_temp_root(tmp_path),
        git_init=_git_init([]),
    )

    assert result == 0
    assert seen_workspaces == [temporary.resolve()]
    assert adapter is not None and adapter.work_order == smoke_codex.WORK_ORDER
    assert smoke_codex.paths_are_disjoint(production, seen_workspaces[0])


@pytest.mark.asyncio
async def test_apply_rejects_system_temporary_root_inside_production_before_manager(
    tmp_path: Path,
) -> None:
    production = tmp_path / "production"
    production.mkdir()
    manager_called = False

    def temporary_directory() -> _TemporaryDirectory:
        nonlocal manager_called
        manager_called = True
        return _TemporaryDirectory(tmp_path / "temporary")

    result = await smoke_codex.run_smoke(
        apply=True,
        settings=_Settings(production),
        temporary_directory=temporary_directory,
        temporary_root=lambda: production / "system-temp",
        emit=lambda _: None,
    )

    assert result == 1
    assert manager_called is False


@pytest.mark.asyncio
async def test_apply_rejects_entered_repository_inside_production_before_git_or_transport(
    tmp_path: Path,
) -> None:
    production = tmp_path / "production"
    production.mkdir()
    git_calls: list[tuple[str, ...]] = []
    transport_calls = 0

    def transport_factory(_binary: str, _workspace: Path, _key: str | None) -> _Transport:
        nonlocal transport_calls
        transport_calls += 1
        return _Transport()

    result = await smoke_codex.run_smoke(
        apply=True,
        settings=_Settings(production),
        transport_factory=transport_factory,
        temporary_directory=lambda: _TemporaryDirectory(production / "temporary"),
        temporary_root=lambda: _safe_temp_root(tmp_path),
        git_init=_git_init(git_calls),
        emit=lambda _: None,
    )

    assert result == 1
    assert git_calls == []
    assert transport_calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "adapter_kwargs",
    (
        {"observe_running": False},
        {"file_bytes": b"wrong\n"},
        {"protocol_terminal": "failed"},
        {"transport_closed": False},
        {"exit_code": 1},
        {"process_exited": False},
    ),
)
async def test_apply_requires_running_protocol_exit_and_exact_bytes(
    tmp_path: Path, adapter_kwargs: dict[str, object]
) -> None:
    kwargs = _apply_kwargs(
        tmp_path,
        adapter_factory=lambda _, repository: _Adapter(repository, **adapter_kwargs),
    )

    assert await smoke_codex.run_smoke(**kwargs) == 1  # type: ignore[arg-type]


@pytest.mark.asyncio
@pytest.mark.parametrize("entry_kind", ("extra", "symlink", "directory"))
async def test_apply_rejects_extra_or_non_regular_target_entries(
    tmp_path: Path, entry_kind: str
) -> None:
    class _MalformedAdapter(_Adapter):
        async def dispatch(self, op: str, request: dict[str, str], ctx: object) -> Handoff:
            handoff = await super().dispatch(op, request, ctx)
            target = self.repository / smoke_codex.SMOKE_FILE
            if entry_kind == "extra":
                (self.repository / "extra.txt").write_bytes(b"x")
            elif entry_kind == "symlink":
                target.unlink()
                target.symlink_to(".git")
            else:
                target.unlink()
                target.mkdir()
            return handoff

    kwargs = _apply_kwargs(
        tmp_path, adapter_factory=lambda _, repository: _MalformedAdapter(repository)
    )

    assert await smoke_codex.run_smoke(**kwargs) == 1  # type: ignore[arg-type]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure", ("settings", "temporary_factory", "enter", "preflight", "git", "cleanup")
)
async def test_failures_are_sanitized_and_nonzero(
    tmp_path: Path, failure: str, capsys: pytest.CaptureFixture[str]
) -> None:
    production = tmp_path / "production-private"
    production.mkdir()
    temporary = tmp_path / "temporary-private"
    secret = "codex-api-private-value"
    error = RuntimeError(f"{production} {temporary} {smoke_codex.WORK_ORDER} {secret}")
    kwargs = _apply_kwargs(tmp_path)
    kwargs["settings"] = _Settings(
        production, api_key=secret, error=error if failure == "settings" else None
    )
    kwargs["temporary_directory"] = (
        (lambda: (_ for _ in ()).throw(error))
        if failure == "temporary_factory"
        else lambda: _TemporaryDirectory(
            temporary,
            enter_error=error if failure == "enter" else None,
            cleanup_error=error if failure == "cleanup" else None,
        )
    )
    kwargs["temporary_root"] = lambda: _safe_temp_root(tmp_path)
    kwargs["transport_factory"] = lambda *_: _Transport(
        error=error if failure == "preflight" else None
    )
    kwargs["git_init"] = _git_init([], error=error if failure == "git" else None)

    if failure == "preflight":
        result = await smoke_codex.run_smoke(  # type: ignore[arg-type]
            apply=False,
            settings=kwargs["settings"],
            transport_factory=kwargs["transport_factory"],
        )
    else:
        result = await smoke_codex.run_smoke(**kwargs)  # type: ignore[arg-type]

    captured = capsys.readouterr()
    assert result == 1
    assert captured.out == "Codex smoke failed\n"
    assert captured.err == ""
    assert str(production) not in captured.out
    assert str(temporary) not in captured.out
    assert smoke_codex.WORK_ORDER not in captured.out
    assert secret not in captured.out
    assert "Traceback" not in captured.out


def test_main_sanitizes_unexpected_runner_traceback(capsys: pytest.CaptureFixture[str]) -> None:
    async def raises(_: bool) -> int:
        raise RuntimeError("/private/raw secret work order")

    assert smoke_codex.main([], runner=raises) == 1

    captured = capsys.readouterr()
    assert captured.out == "Codex smoke failed\n"
    assert captured.err == ""
    assert "Traceback" not in captured.out


def test_help_discloses_default_workspace_write_probe(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as exc_info:
        smoke_codex.main(["--help"])

    captured = capsys.readouterr()
    assert exc_info.value.code == 0
    assert "configured workspace" in captured.out
    assert "write/remove checks" in captured.out
    assert "disposable repository" in captured.out


def test_main_sanitizes_settings_construction_failure(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def raises() -> object:
        raise RuntimeError("/private/raw secret work order")

    monkeypatch.setattr(smoke_codex, "Settings", raises)

    assert smoke_codex.main([]) == 1

    captured = capsys.readouterr()
    assert captured.out == "Codex smoke failed\n"
    assert captured.err == ""
    assert "Traceback" not in captured.out
