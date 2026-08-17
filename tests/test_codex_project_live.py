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


def _context(
    clock: VirtualClock,
    *,
    origin_ref: str = "conversation:1",
    delegate_id: str = "delegate-run",
    private: object | None = None,
) -> DispatchContext:
    return SimpleNamespace(
        clock=clock,
        progress=None,
        delegate=SimpleNamespace(
            origin_ref=origin_ref,
            delegate_id=delegate_id,
            private=private,
        ),
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


class _NeverReadyWorker(_ProjectWorker):
    async def preflight(self, **_kwargs: Any) -> Mapping[str, Any]:
        raise RuntimeError("missing history")


class _ResumeUnavailableWorker(_ProjectWorker):
    async def run(self, *_args: Any, **_kwargs: Any) -> CodexTransportResult:
        return CodexTransportResult(
            classification="refused",
            code="resume_unavailable",
            content={},
        )


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
async def test_invalid_create_is_rejected_before_confirmation(tmp_path: Path) -> None:
    adapter, _store = _adapter(tmp_path)

    invalid = await adapter.dispatch(
        "project",
        {"action": "create", "workspace": "../etc"},
        _context(VirtualClock()),
    )
    conflict = await adapter.dispatch(
        "project",
        {"action": "create", "workspace": "alpha"},
        _context(VirtualClock()),
    )

    assert invalid.outcome == conflict.outcome == "failed"
    assert invalid.content["code"] == "workspace_name_invalid"
    assert conflict.content["code"] == "workspace_name_conflict"
    assert adapter.confirmation.pending is False


@pytest.mark.asyncio
async def test_lists_are_public_and_exact_names_are_required(tmp_path: Path) -> None:
    adapter, store = _adapter(tmp_path)
    ctx = _context(VirtualClock())
    store.create_managed("beta")
    store.select_workspace("alpha")

    listed = await adapter.dispatch("project", {"action": "list"}, ctx)
    current_sessions = await adapter.dispatch("project", {"action": "sessions"}, ctx)
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
    assert current_sessions.content == {
        "op": "project",
        "code": "sessions_listed",
        "workspace": "alpha",
        "sessions": [],
    }

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
    resumed = await adapter.dispatch(
        "run",
        {"work_order": "continue it"},
        _context(
            clock,
            delegate_id="delegate-resume",
            private=dispatched[0][0].private,
        ),
    )

    assert committed.accepted is True
    assert dispatched[0][0].request == {"work_order": "continue it"}
    assert resumed.outcome == "ok"
    assert factory.calls[-1][2] == saved.codex_thread_id
    assert len(factory.calls) == 2


@pytest.mark.asyncio
async def test_confirmed_dispatch_reserves_global_slot_and_exact_work_order(tmp_path: Path) -> None:
    adapter, store = _adapter(tmp_path)
    clock = VirtualClock()
    controller = adapter.confirmation
    controller.prepare(
        action="create",
        workspace_display_name="beta",
        workspace_id=None,
        session_title=None,
        session_id=None,
        work_order="host work",
        origin_ref="conversation:2",
    )
    assert controller.reserve_user_item(epoch=1, item_id="user-confirm")
    outcome = controller.accept_transcript(epoch=1, item_id="user-confirm", text="确认")
    assert outcome.operation is not None

    dispatched: list[Any] = []

    def dispatch(request: Any, *, reason: Any) -> RuntimeDispatchResult:
        dispatched.append((request, reason))
        return RuntimeDispatchResult(accepted=True, delegate_id="host-delegate")

    committed = await adapter.commit_confirmed(
        outcome.operation,
        origin_ref="conversation:2",
        runtime_dispatch=dispatch,
    )
    unrelated = await adapter.dispatch(
        "run",
        {"work_order": "overtake"},
        _context(clock, origin_ref="conversation:3"),
    )
    mismatched = await adapter.dispatch(
        "run",
        {"work_order": "wrong work"},
        _context(
            clock,
            origin_ref="conversation:2",
            delegate_id="host-delegate",
            private=outcome.operation,
        ),
    )

    assert committed.accepted is True
    assert dispatched[0][0].private is outcome.operation
    assert unrelated.content != {"error": "busy", "op": "run"}
    assert mismatched.content == {"error": "confirmation_binding_mismatch", "op": "run"}


@pytest.mark.asyncio
async def test_confirmed_work_order_is_normalized_once_before_runtime_dispatch(
    tmp_path: Path,
) -> None:
    adapter, _store = _adapter(tmp_path)
    controller = adapter.confirmation
    proposal = await adapter.dispatch(
        "project",
        {
            "action": "create",
            "workspace": "beta",
            "work_order": "  host work\n",
        },
        _context(VirtualClock(), origin_ref="conversation:2"),
    )
    assert proposal.content["code"] == "confirmation_required"
    assert controller.reserve_user_item(epoch=1, item_id="user-confirm")
    outcome = controller.accept_transcript(epoch=1, item_id="user-confirm", text="确认")
    assert outcome.operation is not None
    dispatched: list[Any] = []

    def dispatch(request: Any, *, reason: Any) -> RuntimeDispatchResult:
        dispatched.append((request, reason))
        return RuntimeDispatchResult(accepted=True, delegate_id="host-delegate")

    committed = await adapter.commit_confirmed(
        outcome.operation,
        origin_ref="conversation:2",
        runtime_dispatch=dispatch,
    )
    result = await adapter.dispatch(
        "run",
        dispatched[0][0].request,
        _context(
            VirtualClock(),
            origin_ref="conversation:2",
            delegate_id="host-delegate",
            private=outcome.operation,
        ),
    )

    assert committed.accepted is True
    assert dispatched[0][0].request == {"work_order": "host work"}
    assert result.content != {"error": "confirmation_binding_mismatch", "op": "run"}


@pytest.mark.asyncio
async def test_dropped_confirmed_delegate_cannot_make_later_run_busy(tmp_path: Path) -> None:
    adapter, _store = _adapter(tmp_path)
    controller = adapter.confirmation
    controller.prepare(
        action="create",
        workspace_display_name="beta",
        workspace_id=None,
        session_title=None,
        session_id=None,
        work_order="first",
        origin_ref="conversation:2",
    )
    assert controller.reserve_user_item(epoch=1, item_id="user-confirm")
    outcome = controller.accept_transcript(epoch=1, item_id="user-confirm", text="确认")
    assert outcome.operation is not None
    committed = await adapter.commit_confirmed(
        outcome.operation,
        origin_ref="conversation:2",
        runtime_dispatch=lambda _request, *, reason: RuntimeDispatchResult(
            accepted=True,
            delegate_id="dropped-delegate",
        ),
    )

    later = await adapter.dispatch(
        "run",
        {"work_order": "later"},
        _context(VirtualClock(), delegate_id="later-delegate"),
    )

    assert committed.accepted is True
    assert later.content != {"error": "busy", "op": "run"}


@pytest.mark.asyncio
async def test_transient_resume_transport_failure_preserves_ready_session(
    tmp_path: Path,
) -> None:
    clock = VirtualClock(start=10.0)
    identifiers = iter(f"identifier-{index:03d}" for index in range(100))
    store = CodexProjectStore(
        tmp_path / "state",
        tmp_path / "managed",
        now=clock.now,
        id_factory=identifiers.__next__,
    )
    workspace = store.create_managed("alpha")
    confirmation = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    factory = _ProjectFactory()
    adapter = ProjectCodexAdapter(store=store, confirmation=confirmation, worker_factory=factory)
    await adapter.dispatch("run", {"work_order": "first", "session": "Task One"}, _context(clock))
    saved = store.resolve_session(workspace.workspace_id, "Task One")
    adapter._worker_factory = lambda _workspace, _home, resume, on_ready: _NeverReadyWorker(
        resume or "missing", on_ready
    )
    confirmation.prepare(
        action="resume",
        workspace_display_name="alpha",
        workspace_id=workspace.workspace_id,
        session_title=saved.display_title,
        session_id=saved.session_id,
        work_order="continue",
        origin_ref="conversation:2",
    )
    confirmation.reserve_user_item(epoch=1, item_id="user-confirm")
    outcome = confirmation.accept_transcript(epoch=1, item_id="user-confirm", text="确认")
    assert outcome.operation is not None
    dispatched: list[Any] = []

    def dispatch(request: Any, *, reason: Any) -> RuntimeDispatchResult:
        dispatched.append((request, reason))
        return RuntimeDispatchResult(accepted=True, delegate_id="resume-delegate")

    await adapter.commit_confirmed(
        outcome.operation,
        origin_ref="conversation:2",
        runtime_dispatch=dispatch,
    )

    result = await adapter.dispatch(
        "run",
        {"work_order": "continue"},
        _context(
            clock,
            origin_ref="conversation:2",
            delegate_id="resume-delegate",
            private=dispatched[0][0].private,
        ),
    )

    assert result.outcome == "failed"
    assert store.resolve_session(workspace.workspace_id, "Task One").state == "ready"


@pytest.mark.asyncio
async def test_resume_history_rejection_marks_session_unavailable(tmp_path: Path) -> None:
    clock = VirtualClock(start=10.0)
    identifiers = iter(f"identifier-{index:03d}" for index in range(100))
    store = CodexProjectStore(
        tmp_path / "state",
        tmp_path / "managed",
        now=clock.now,
        id_factory=identifiers.__next__,
    )
    workspace = store.create_managed("alpha")
    confirmation = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    factory = _ProjectFactory()
    adapter = ProjectCodexAdapter(store=store, confirmation=confirmation, worker_factory=factory)
    await adapter.dispatch("run", {"work_order": "first", "session": "Task One"}, _context(clock))
    saved = store.resolve_session(workspace.workspace_id, "Task One")
    adapter._worker_factory = lambda _workspace, _home, resume, on_ready: _ResumeUnavailableWorker(
        resume or "missing", on_ready
    )
    confirmation.prepare(
        action="resume",
        workspace_display_name="alpha",
        workspace_id=workspace.workspace_id,
        session_title=saved.display_title,
        session_id=saved.session_id,
        work_order="continue",
        origin_ref="conversation:2",
    )
    confirmation.reserve_user_item(epoch=1, item_id="user-confirm")
    outcome = confirmation.accept_transcript(epoch=1, item_id="user-confirm", text="确认")
    assert outcome.operation is not None
    dispatched: list[Any] = []

    def dispatch(request: Any, *, reason: Any) -> RuntimeDispatchResult:
        dispatched.append((request, reason))
        return RuntimeDispatchResult(accepted=True, delegate_id="resume-delegate")

    await adapter.commit_confirmed(
        outcome.operation,
        origin_ref="conversation:2",
        runtime_dispatch=dispatch,
    )
    result = await adapter.dispatch(
        "run",
        {"work_order": "continue"},
        _context(
            clock,
            origin_ref="conversation:2",
            delegate_id="resume-delegate",
            private=dispatched[0][0].private,
        ),
    )

    assert result.outcome == "failed"
    assert result.content["code"] == "resume_unavailable"
    assert store.resolve_session(workspace.workspace_id, "Task One").state == "unavailable"


@pytest.mark.asyncio
async def test_failed_new_run_rolls_back_provisional_session(tmp_path: Path) -> None:
    clock = VirtualClock(start=10.0)
    store = CodexProjectStore(
        tmp_path / "state",
        tmp_path / "managed",
        now=clock.now,
        id_factory=iter((f"identifier-{index:03d}" for index in range(100))).__next__,
    )
    workspace = store.create_managed("alpha")
    adapter = ProjectCodexAdapter(
        store=store,
        confirmation=ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce"),
        worker_factory=lambda _workspace, _home, resume, on_ready: _NeverReadyWorker(
            resume or "missing", on_ready
        ),
    )

    result = await adapter.dispatch("run", {"work_order": "first"}, _context(clock))

    assert result.outcome == "failed"
    assert store.list_sessions(workspace) == ()
