from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Mapping
import hashlib

import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.executors.codex_project_live import (
    CODEX_PROJECT_LIVE_MANIFEST,
    ProjectCodexAdapter,
)
from nova_audio_agent.executors.codex import CodexProcessStatus, CodexTransportResult
from nova_audio_agent.executors.codex_app_server import SteerTransportResult
from nova_audio_agent.executors.codex_projects import CodexProjectStore
from nova_audio_agent.ports import DispatchContext
from nova_audio_agent.realtime.project_confirmation import ProjectConfirmationController
from nova_audio_agent.runtime import RuntimeDispatchResult
from nova_audio_agent.tool_schema import compile_tool_schema


def _context(clock: VirtualClock) -> DispatchContext:
    return SimpleNamespace(
        clock=clock,
        progress=None,
        delegate=SimpleNamespace(origin_ref="conversation:1"),
    )


def _adapter(tmp_path: Path) -> tuple[ProjectCodexAdapter, CodexProjectStore]:
    clock = VirtualClock()
    store = CodexProjectStore(
        tmp_path / "state",
        tmp_path / "managed",
        now=clock.now,
        id_factory=iter((f"identifier-{index:03d}" for index in range(100))).__next__,
    )
    store.create_managed("alpha")
    controller = ProjectConfirmationController(
        clock=clock,
        id_factory=iter((f"nonce-{index}" for index in range(100))).__next__,
    )
    return (
        ProjectCodexAdapter(
            store=store,
            confirmation=controller,
            worker_factory=lambda *_args, **_kwargs: _UnusedWorker(),
        ),
        store,
    )


class _UnusedWorker:
    async def aclose(self) -> None:  # pragma: no cover - action tests do not run work
        return None


def _completed() -> CodexTransportResult:
    text = "done"
    return CodexTransportResult(
        classification="completed",
        code="completed",
        content={
            "events": [
                {"type": "thread.started"},
                {"type": "turn.started"},
                {"type": "turn.completed"},
            ],
            "protocol": {
                "thread_started": True,
                "turn_started": True,
                "terminal": "completed",
                "transport_closed": True,
                "unknown_event_count": 0,
            },
            "process": {"started": True, "exit_code": 0, "stop": "none"},
            "result": {
                "final_message": {
                    "text": text,
                    "original_chars": len(text),
                    "truncated": False,
                    "sha256": hashlib.sha256(text.encode()).hexdigest(),
                }
            },
        },
    )


class _ProjectWorker:
    def __init__(self, thread_id: str, on_ready: Callable[[str], None]) -> None:
        self.thread_id = thread_id
        self.on_ready = on_ready

    async def preflight(self, **_kwargs: Any) -> Mapping[str, Any]:
        return {
            "version": "0.145.0",
            "root_matches": True,
            "mount": "workspace_only",
            "subprocess": "contained",
            "network": "blocked",
            "credential": {"present": True, "identity": "chatgpt", "policy": "saved_login"},
            "limits": {"cpu": "finite", "as": "finite", "nofile": "finite"},
        }

    async def prewarm(self, **_kwargs: Any) -> Mapping[str, Any]:
        return await self.preflight()

    async def run(
        self, _work_order: str, *, on_status: Any, **_kwargs: Any
    ) -> CodexTransportResult:
        self.on_ready(self.thread_id)
        on_status(CodexProcessStatus(running=True, exited=False))
        on_status(CodexProcessStatus(running=False, exited=True, terminal="completed", exit_code=0))
        return _completed()

    async def steer(self, _instruction: str) -> SteerTransportResult:
        return SteerTransportResult(code="accepted", written=True)

    async def aclose(self) -> None:
        return None


class _ProjectFactory:
    def __init__(self) -> None:
        self.calls: list[tuple[Path, Path, str | None]] = []

    def __call__(
        self, workspace: Path, codex_home: Path, resume: str | None, on_ready: Any
    ) -> _ProjectWorker:
        self.calls.append((workspace, codex_home, resume))
        return _ProjectWorker(resume or f"thread-{len(self.calls)}", on_ready)


def test_project_mode_exposes_one_additional_flat_tool() -> None:
    tools = compile_tool_schema((CODEX_PROJECT_LIVE_MANIFEST,))
    names = [
        item["function"]["name"]
        for item in tools.schemas
        if item["function"]["name"].startswith("codex__")
    ]
    assert names == ["codex__run", "codex__project", "codex__steer", "codex__status"]
    project = next(
        item["function"] for item in tools.schemas if item["function"]["name"] == "codex__project"
    )
    assert set(project["parameters"]["properties"]) == {
        "action",
        "workspace",
        "session",
        "work_order",
        "origin_ref",
    }


@pytest.mark.asyncio
async def test_project_action_validation_and_proposal_only_dispatch(tmp_path: Path) -> None:
    adapter, store = _adapter(tmp_path)
    ctx = _context(VirtualClock())

    invalid = (
        {"action": "list", "workspace": "alpha"},
        {"action": "sessions"},
        {"action": "create"},
        {"action": "select"},
        {"action": "resume", "workspace": "alpha", "session": "missing"},
        {"action": "wat"},
        {"action": "list", "extra": True},
    )
    for request in invalid:
        result = await adapter.dispatch("project", request, ctx)
        assert result.outcome == "failed"
        assert result.content["error"] == "invalid_params"

    before = store.snapshot()
    proposal = await adapter.dispatch(
        "project",
        {"action": "create", "workspace": "beta", "work_order": "build it"},
        ctx,
    )
    assert proposal.outcome == "ok"
    assert proposal.content == {
        "op": "project",
        "code": "confirmation_required",
        "action": "create",
        "workspace": "beta",
        "session": None,
        "confirmation_prompt": "准备创建工作区beta，并在其中开始任务，请确认或取消。",
    }
    assert store.snapshot() == before


@pytest.mark.asyncio
async def test_lists_are_public_and_exact_names_are_required(tmp_path: Path) -> None:
    adapter, store = _adapter(tmp_path)
    ctx = _context(VirtualClock())
    store.create_managed("beta")
    store.select_workspace("alpha")

    listed = await adapter.dispatch("project", {"action": "list"}, ctx)
    assert listed.outcome == "ok"
    assert listed.content == {
        "op": "project",
        "code": "listed",
        "workspaces": [
            {"workspace": "alpha", "active": True},
            {"workspace": "beta", "active": False},
        ],
    }
    assert not any(
        private in repr(listed.content)
        for private in ("canonical_path", "workspace_id", "codex_home", "nonce")
    )

    missing = await adapter.dispatch("project", {"action": "select", "workspace": "alp"}, ctx)
    assert missing.outcome == "failed"
    assert missing.content == {
        "op": "project",
        "code": "workspace_not_found",
        "candidates": ["alpha", "beta"],
    }


@pytest.mark.asyncio
async def test_plain_runs_create_distinct_sessions_in_one_persistent_home(tmp_path: Path) -> None:
    clock = VirtualClock(start=10.0)
    identifiers = iter(f"identifier-{index:03d}" for index in range(100))
    store = CodexProjectStore(
        tmp_path / "state", tmp_path / "managed", now=clock.now, id_factory=identifiers.__next__
    )
    workspace = store.create_managed("alpha")
    confirmation = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    factory = _ProjectFactory()
    adapter = ProjectCodexAdapter(store=store, confirmation=confirmation, worker_factory=factory)

    first = await adapter.dispatch("run", {"work_order": "first"}, _context(clock))
    second = await adapter.dispatch("run", {"work_order": "second"}, _context(clock))

    assert first.outcome == second.outcome == "ok"
    sessions = store.list_sessions(workspace)
    assert len(sessions) == 2
    assert {item.codex_thread_id for item in sessions} == {"thread-1", "thread-2"}
    assert factory.calls[0][1] == factory.calls[1][1] == store.codex_home(workspace)
    assert factory.calls[0][2] is factory.calls[1][2] is None


@pytest.mark.asyncio
async def test_two_workspaces_use_different_codex_homes(tmp_path: Path) -> None:
    clock = VirtualClock(start=10.0)
    identifiers = iter(f"identifier-{index:03d}" for index in range(100))
    store = CodexProjectStore(
        tmp_path / "state", tmp_path / "managed", now=clock.now, id_factory=identifiers.__next__
    )
    alpha = store.create_managed("alpha")
    beta = store.create_managed("beta")
    factory = _ProjectFactory()
    adapter = ProjectCodexAdapter(
        store=store,
        confirmation=ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce"),
        worker_factory=factory,
    )

    store.select_workspace("alpha")
    await adapter.dispatch("run", {"work_order": "alpha task"}, _context(clock))
    store.select_workspace("beta")
    await adapter.dispatch("run", {"work_order": "beta task"}, _context(clock))

    assert factory.calls[0][1] == store.codex_home(alpha)
    assert factory.calls[1][1] == store.codex_home(beta)
    assert factory.calls[0][1] != factory.calls[1][1]


@pytest.mark.asyncio
async def test_confirmed_resume_reuses_thread_in_a_new_worker(tmp_path: Path) -> None:
    clock = VirtualClock(start=10.0)
    identifiers = iter(f"identifier-{index:03d}" for index in range(100))
    store = CodexProjectStore(
        tmp_path / "state", tmp_path / "managed", now=clock.now, id_factory=identifiers.__next__
    )
    workspace = store.create_managed("alpha")
    confirmation = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    factory = _ProjectFactory()
    adapter = ProjectCodexAdapter(store=store, confirmation=confirmation, worker_factory=factory)
    await adapter.dispatch("run", {"work_order": "first", "session": "Task One"}, _context(clock))
    saved = store.resolve_session(workspace.workspace_id, "Task One")
    confirmation.prepare(
        action="resume",
        workspace_display_name="alpha",
        workspace_id=workspace.workspace_id,
        session_title=saved.display_title,
        session_id=saved.session_id,
        work_order="continue it",
        origin_ref="conversation:1",
    )
    assert confirmation.reserve_user_item(epoch=1, item_id="user-2")
    outcome = confirmation.accept_transcript(epoch=1, item_id="user-2", text="确认")
    assert outcome.operation is not None
    dispatched: list[Any] = []

    def dispatch(request: Any, *, reason: Any) -> RuntimeDispatchResult:
        dispatched.append((request, reason))
        return RuntimeDispatchResult(accepted=True, delegate_id="delegate-resume")

    committed = await adapter.commit_confirmed(
        outcome.operation, origin_ref="conversation:1", runtime_dispatch=dispatch
    )
    resumed = await adapter.dispatch("run", {"work_order": "continue it"}, _context(clock))

    assert committed.accepted is True
    assert dispatched[0][0].request == {"work_order": "continue it"}
    assert resumed.outcome == "ok"
    assert factory.calls[-1][2] == saved.codex_thread_id
    assert len(factory.calls) == 2
