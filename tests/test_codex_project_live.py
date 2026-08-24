from __future__ import annotations

import asyncio
import fcntl
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Mapping
import hashlib

import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.executors.codex_project_live import (
    CODEX_PROJECT_LIVE_MANIFEST,
    ProjectCodexAdapter,
    ProjectCommitResult,
    _normalize_project_request,
)
from nova_audio_agent.executors.codex import CodexProcessStatus, CodexTransportResult
from nova_audio_agent.executors.codex_app_server import SteerTransportResult
from nova_audio_agent.executors.codex_projects import (
    CodexProjectStore,
    ProjectStateError,
    PublicProjectView,
)
from nova_audio_agent.ports import DispatchContext
from nova_audio_agent.realtime.project_confirmation import (
    ConfirmedProjectOperation,
    ProjectConfirmationController,
)
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


def test_project_mode_exposes_project_and_confirmation_tools() -> None:
    tools = compile_tool_schema((CODEX_PROJECT_LIVE_MANIFEST,))
    names = [
        item["function"]["name"]
        for item in tools.schemas
        if item["function"]["name"].startswith("codex__")
    ]
    assert names == [
        "codex__project",
        "codex__confirm_project_action",
        "codex__steer",
        "codex__status",
    ]
    confirmation = next(
        item["function"]
        for item in tools.schemas
        if item["function"]["name"] == "codex__confirm_project_action"
    )
    assert confirmation["parameters"] == {
        "type": "object",
        "properties": {
            "proposal_id": {"type": "string", "minLength": 1, "maxLength": 128},
            "confirmed": {"type": "boolean"},
        },
        "required": ["proposal_id", "confirmed"],
        "additionalProperties": False,
    }
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
    assert _normalize_project_request(
        {
            "action": "start_session",
            "work_order": "fix login",
        }
    ) == {"action": "start_session", "work_order": "fix login"}
    assert _normalize_project_request(
        {
            "action": "create_workspace",
            "workspace": "alpha",
            "work_order": "build with default Session",
        }
    ) == {
        "action": "create_workspace",
        "workspace": "alpha",
        "work_order": "build with default Session",
    }


@pytest.mark.parametrize(
    "normalized_request",
    (
        {"action": "list_sessions", "workspace": None},
        {
            "action": "create_workspace",
            "workspace": "alpha",
            "session": None,
            "work_order": None,
        },
        {"action": "start_session", "work_order": "fix login", "session": None},
        {"action": "resume_session", "work_order": "continue", "workspace": None},
        {"action": "resume_session", "work_order": "continue", "session": None},
    ),
)
def test_project_request_rejects_explicit_null_for_optional_fields(
    normalized_request: dict[str, object],
) -> None:
    assert _normalize_project_request(normalized_request) is None


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
        {
            "action": "create_workspace",
            "workspace": "beta",
            "session": "Initial",
            "work_order": "build it",
        },
        ctx,
    )
    assert proposal.outcome == "ok"
    assert proposal.content == {
        "op": "project",
        "code": "confirmation_required",
        "proposal_id": "nonce-0",
        "expires_at": 90.0,
        "action": "create_workspace",
        "workspace": "beta",
        "session": "Initial",
        "confirmation_prompt": "准备创建工作区beta，并在其中开始任务，请确认或取消。",
    }
    assert store.snapshot() == before


@pytest.mark.asyncio
async def test_select_and_resume_proposals_include_ids_expiry_and_resolved_names(
    tmp_path: Path,
) -> None:
    adapter, store = _adapter(tmp_path)
    workspace = store.resolve_workspace("alpha")
    session = store.begin_session(workspace.workspace_id, "Existing")
    store.mark_session_ready(session.session_id, "thread-existing")
    ctx = _context(VirtualClock())

    selected = await adapter.dispatch(
        "project", {"action": "select_workspace", "workspace": "ALPHA"}, ctx
    )
    resumed = await adapter.dispatch(
        "project",
        {
            "action": "resume_session",
            "workspace": "alpha",
            "session": "existing",
            "work_order": "continue exactly",
        },
        ctx,
    )

    assert selected.content == {
        "op": "project",
        "code": "confirmation_required",
        "proposal_id": "nonce-0",
        "expires_at": 90.0,
        "action": "select_workspace",
        "workspace": "alpha",
        "session": None,
        "confirmation_prompt": "准备切换到工作区alpha，请确认或取消。",
    }
    assert resumed.content == {
        "op": "project",
        "code": "confirmation_required",
        "proposal_id": "nonce-1",
        "expires_at": 90.0,
        "action": "resume_session",
        "workspace": "alpha",
        "session": "Existing",
        "confirmation_prompt": "准备切换到alpha，并继续 Session“Existing”，请确认或取消。",
    }


@pytest.mark.asyncio
async def test_public_run_and_execute_confirmed_are_rejected(tmp_path: Path) -> None:
    adapter, _store = _adapter(tmp_path)
    ctx = _context(VirtualClock())

    public_run = await adapter.dispatch("run", {"work_order": "forbidden"}, ctx)
    public_confirmed = await adapter.dispatch("project", {"action": "execute_confirmed"}, ctx)

    assert public_run.outcome == public_confirmed.outcome == "failed"


@pytest.mark.asyncio
async def test_invalid_create_is_rejected_before_confirmation(tmp_path: Path) -> None:
    adapter, _store = _adapter(tmp_path)

    invalid = await adapter.dispatch(
        "project",
        {"action": "create_workspace", "workspace": "../etc"},
        _context(VirtualClock()),
    )
    conflict = await adapter.dispatch(
        "project",
        {"action": "create_workspace", "workspace": "alpha"},
        _context(VirtualClock()),
    )

    assert invalid.outcome == conflict.outcome == "failed"
    assert invalid.content["code"] == "workspace_name_invalid"
    assert conflict.content["code"] == "workspace_name_conflict"
    assert adapter.confirmation.pending is False


@pytest.mark.asyncio
async def test_project_proposal_schedules_expiry_on_the_event_loop(tmp_path: Path) -> None:
    clock = VirtualClock()
    store = CodexProjectStore(
        tmp_path / "state",
        tmp_path / "managed",
        now=clock.now,
        id_factory=iter((f"identifier-{index:03d}" for index in range(100))).__next__,
    )
    store.create_managed("alpha")
    adapter = ProjectCodexAdapter(
        store=store,
        confirmation=ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce"),
        worker_factory=lambda *_args, **_kwargs: _UnusedWorker(),
    )

    result = await adapter.dispatch(
        "project",
        {"action": "select_workspace", "workspace": "alpha"},
        _context(clock),
    )
    await asyncio.sleep(0)

    assert result.content["code"] == "confirmation_required"
    assert clock.waiter_count() == 1


@pytest.mark.asyncio
async def test_lists_are_public_and_exact_names_are_required(tmp_path: Path) -> None:
    adapter, store = _adapter(tmp_path)
    ctx = _context(VirtualClock())
    store.create_managed("beta")
    store.select_workspace("alpha")

    listed = await adapter.dispatch("project", {"action": "list_workspaces"}, ctx)
    current_sessions = await adapter.dispatch("project", {"action": "list_sessions"}, ctx)
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

    missing = await adapter.dispatch(
        "project", {"action": "select_workspace", "workspace": "alp"}, ctx
    )
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

    first = await adapter.dispatch(
        "project", {"action": "start_session", "work_order": "first"}, _context(clock)
    )
    second = await adapter.dispatch(
        "project", {"action": "start_session", "work_order": "second"}, _context(clock)
    )

    assert first.outcome == second.outcome == "ok"
    sessions = store.list_sessions(workspace)
    assert len(sessions) == 2
    assert {item.codex_thread_id for item in sessions} == {"thread-1", "thread-2"}
    assert factory.calls[0][1] == factory.calls[1][1] == store.codex_home(workspace)
    assert factory.calls[0][2] is factory.calls[1][2] is None


@pytest.mark.asyncio
async def test_active_session_view_delivery_completes_before_worker_construction(
    tmp_path: Path,
) -> None:
    clock = VirtualClock(start=10.0)
    store = CodexProjectStore(
        tmp_path / "state",
        tmp_path / "managed",
        now=clock.now,
        id_factory=iter((f"identifier-{index:03d}" for index in range(100))).__next__,
    )
    store.create_managed("alpha")
    factory = _ProjectFactory()
    adapter = ProjectCodexAdapter(
        store=store,
        confirmation=ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce"),
        worker_factory=factory,
    )
    publication_started = asyncio.Event()
    release_publication = asyncio.Event()

    def publish(view: Any) -> Any:
        if view.session_title != "任务 1":
            return None
        publication_started.set()
        return release_publication.wait()

    adapter.observe_project_view(publish)
    run = asyncio.create_task(
        adapter.dispatch(
            "project", {"action": "start_session", "work_order": "publish first"}, _context(clock)
        )
    )
    await asyncio.wait_for(publication_started.wait(), timeout=1.0)
    await asyncio.sleep(0)
    constructed_early = bool(factory.calls)
    release_publication.set()
    result = await run

    assert constructed_early is False
    assert result.outcome == "ok"


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
    await adapter.dispatch(
        "project", {"action": "start_session", "work_order": "alpha task"}, _context(clock)
    )
    store.select_workspace("beta")
    await adapter.dispatch(
        "project", {"action": "start_session", "work_order": "beta task"}, _context(clock)
    )

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
    await adapter.dispatch(
        "project",
        {"action": "start_session", "work_order": "first", "session": "Task One"},
        _context(clock),
    )
    saved = store.resolve_session(workspace.workspace_id, "Task One")
    proposal = confirmation.prepare(
        action="resume",
        workspace_display_name="alpha",
        workspace_id=workspace.workspace_id,
        session_title=saved.display_title,
        session_id=saved.session_id,
        work_order="continue it",
        origin_ref="conversation:1",
    )
    assert confirmation.reserve_user_item(epoch=1, item_id="user-2")
    outcome = confirmation.accept_decision(
        epoch=1,
        item_id="user-2",
        proposal_id=proposal.proposal_id,
        confirmed=True,
    )
    assert outcome.operation is not None
    dispatched: list[Any] = []

    def dispatch(request: Any, *, reason: Any) -> RuntimeDispatchResult:
        dispatched.append((request, reason))
        return RuntimeDispatchResult(accepted=True, delegate_id="delegate-resume")

    committed = await adapter.commit_confirmed(
        outcome.operation, origin_ref="conversation:1", runtime_dispatch=dispatch
    )
    resumed = await adapter.dispatch(
        "project",
        {"action": "execute_confirmed"},
        _context(
            clock,
            delegate_id="delegate-resume",
            private=dispatched[0][0].private,
        ),
    )
    replayed = await adapter.dispatch(
        "project",
        {"action": "execute_confirmed"},
        _context(
            clock,
            delegate_id="delegate-resume",
            private=dispatched[0][0].private,
        ),
    )

    assert committed.accepted is True
    assert dispatched[0][0].request == {"action": "execute_confirmed"}
    assert resumed.outcome == "ok"
    assert replayed.content == {"error": "confirmation_binding_mismatch", "op": "project"}
    assert factory.calls[-1][2] == saved.codex_thread_id
    assert len(factory.calls) == 2


@pytest.mark.asyncio
async def test_confirmed_resume_revalidates_ready_state_at_execution_time(
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
    await adapter.dispatch(
        "project",
        {"action": "start_session", "work_order": "first", "session": "Task One"},
        _context(clock),
    )
    saved = store.resolve_session(workspace.workspace_id, "Task One")
    proposal = confirmation.prepare(
        action="resume",
        workspace_display_name="alpha",
        workspace_id=workspace.workspace_id,
        session_title=saved.display_title,
        session_id=saved.session_id,
        work_order="continue it",
        origin_ref="conversation:1",
    )
    assert confirmation.reserve_user_item(epoch=1, item_id="user-2")
    outcome = confirmation.accept_decision(
        epoch=1,
        item_id="user-2",
        proposal_id=proposal.proposal_id,
        confirmed=True,
    )
    assert outcome.operation is not None
    store.mark_session_unavailable(saved.session_id)
    dispatched: list[Any] = []

    def dispatch(request: Any, *, reason: Any) -> RuntimeDispatchResult:
        dispatched.append((request, reason))
        return RuntimeDispatchResult(accepted=True, delegate_id="delegate-resume")

    committed = await adapter.commit_confirmed(
        outcome.operation, origin_ref="conversation:1", runtime_dispatch=dispatch
    )
    resumed = await adapter.dispatch(
        "project",
        {"action": "execute_confirmed"},
        _context(
            clock,
            delegate_id="delegate-resume",
            private=dispatched[0][0].private,
        ),
    )

    assert committed.accepted is True
    assert resumed.outcome == "failed"
    assert resumed.content["error"] == "session_unavailable"
    assert len(factory.calls) == 1


@pytest.mark.asyncio
async def test_confirmed_dispatch_reserves_global_slot_and_exact_work_order(tmp_path: Path) -> None:
    adapter, store = _adapter(tmp_path)
    clock = VirtualClock()
    controller = adapter.confirmation
    proposal = controller.prepare(
        action="create",
        workspace_display_name="beta",
        workspace_id=None,
        session_title=None,
        session_id=None,
        work_order="host work",
        origin_ref="conversation:2",
    )
    assert controller.reserve_user_item(epoch=1, item_id="user-confirm")
    outcome = controller.accept_decision(
        epoch=1,
        item_id="user-confirm",
        proposal_id=proposal.proposal_id,
        confirmed=True,
    )
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
        "project",
        {"action": "start_session", "work_order": "overtake"},
        _context(clock, origin_ref="conversation:3"),
    )
    mismatched = await adapter.dispatch(
        "project",
        {"action": "start_session", "work_order": "wrong work"},
        _context(
            clock,
            origin_ref="conversation:2",
            delegate_id="host-delegate",
            private=outcome.operation,
        ),
    )

    assert committed.accepted is True
    assert dispatched[0][0].private is outcome.operation
    assert unrelated.content != {"error": "busy", "op": "project"}
    assert mismatched.content == {"error": "invalid_operation", "op": "project"}


@pytest.mark.asyncio
async def test_confirmed_work_order_is_normalized_once_before_runtime_dispatch(
    tmp_path: Path,
) -> None:
    adapter, _store = _adapter(tmp_path)
    controller = adapter.confirmation
    proposal = await adapter.dispatch(
        "project",
        {
            "action": "create_workspace",
            "workspace": "beta",
            "session": "Initial",
            "work_order": "  host work\n",
        },
        _context(VirtualClock(), origin_ref="conversation:2"),
    )
    assert proposal.content["code"] == "confirmation_required"
    assert controller.reserve_user_item(epoch=1, item_id="user-confirm")
    outcome = controller.accept_decision(
        epoch=1,
        item_id="user-confirm",
        proposal_id=proposal.content["proposal_id"],
        confirmed=True,
    )
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
        "project",
        dispatched[0][0].request,
        _context(
            VirtualClock(),
            origin_ref="conversation:2",
            delegate_id="host-delegate",
            private=outcome.operation,
        ),
    )

    assert committed.accepted is True
    assert dispatched[0][0].request == {"action": "execute_confirmed"}
    assert result.content != {"error": "confirmation_binding_mismatch", "op": "project"}


@pytest.mark.asyncio
async def test_dropped_confirmed_delegate_cannot_make_later_run_busy(tmp_path: Path) -> None:
    adapter, _store = _adapter(tmp_path)
    controller = adapter.confirmation
    proposal = controller.prepare(
        action="create",
        workspace_display_name="beta",
        workspace_id=None,
        session_title=None,
        session_id=None,
        work_order="first",
        origin_ref="conversation:2",
    )
    assert controller.reserve_user_item(epoch=1, item_id="user-confirm")
    outcome = controller.accept_decision(
        epoch=1,
        item_id="user-confirm",
        proposal_id=proposal.proposal_id,
        confirmed=True,
    )
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
        "project",
        {"action": "start_session", "work_order": "later"},
        _context(VirtualClock(), delegate_id="later-delegate"),
    )

    assert committed.accepted is True
    assert later.content != {"error": "busy", "op": "project"}


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
    await adapter.dispatch(
        "project",
        {"action": "start_session", "work_order": "first", "session": "Task One"},
        _context(clock),
    )
    saved = store.resolve_session(workspace.workspace_id, "Task One")
    adapter._worker_factory = lambda _workspace, _home, resume, on_ready: _NeverReadyWorker(
        resume or "missing", on_ready
    )
    proposal = confirmation.prepare(
        action="resume",
        workspace_display_name="alpha",
        workspace_id=workspace.workspace_id,
        session_title=saved.display_title,
        session_id=saved.session_id,
        work_order="continue",
        origin_ref="conversation:2",
    )
    confirmation.reserve_user_item(epoch=1, item_id="user-confirm")
    outcome = confirmation.accept_decision(
        epoch=1,
        item_id="user-confirm",
        proposal_id=proposal.proposal_id,
        confirmed=True,
    )
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
        "project",
        {"action": "execute_confirmed"},
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
    await adapter.dispatch(
        "project",
        {"action": "start_session", "work_order": "first", "session": "Task One"},
        _context(clock),
    )
    saved = store.resolve_session(workspace.workspace_id, "Task One")
    adapter._worker_factory = lambda _workspace, _home, resume, on_ready: _ResumeUnavailableWorker(
        resume or "missing", on_ready
    )
    proposal = confirmation.prepare(
        action="resume",
        workspace_display_name="alpha",
        workspace_id=workspace.workspace_id,
        session_title=saved.display_title,
        session_id=saved.session_id,
        work_order="continue",
        origin_ref="conversation:2",
    )
    confirmation.reserve_user_item(epoch=1, item_id="user-confirm")
    outcome = confirmation.accept_decision(
        epoch=1,
        item_id="user-confirm",
        proposal_id=proposal.proposal_id,
        confirmed=True,
    )
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
        "project",
        {"action": "execute_confirmed"},
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

    result = await adapter.dispatch(
        "project", {"action": "start_session", "work_order": "first"}, _context(clock)
    )

    assert result.outcome == "failed"
    assert store.list_sessions(workspace) == ()


@pytest.mark.asyncio
async def test_failed_new_run_waits_for_contended_rollback_off_event_loop(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    original = store.rollback_session_start
    entered = threading.Event()
    release = threading.Event()
    observed_wait: list[bool] = []

    def delayed_rollback(session_id: str, *, wait: bool = False) -> bool:
        observed_wait.append(wait)
        entered.set()
        release.wait(1.0)
        return original(session_id, wait=wait)

    monkeypatch.setattr(store, "rollback_session_start", delayed_rollback)
    ticks = 0
    finished = False

    async def ticker() -> None:
        nonlocal ticks
        while not finished:
            ticks += 1
            await asyncio.sleep(0)

    timer = threading.Timer(0.05, release.set)
    timer.start()
    ticker_task = asyncio.create_task(ticker())
    try:
        result = await adapter.dispatch(
            "project", {"action": "start_session", "work_order": "first"}, _context(clock)
        )
    finally:
        finished = True
        await ticker_task
        timer.cancel()

    assert result.outcome == "failed"
    assert entered.is_set()
    assert observed_wait == [True]
    assert ticks > 1
    assert store.list_sessions(workspace) == ()


@pytest.mark.asyncio
async def test_project_registry_io_does_not_block_the_event_loop(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter, store = _adapter(tmp_path)
    original = store.snapshot
    entered = threading.Event()
    release = threading.Event()

    def slow_snapshot() -> Any:
        entered.set()
        release.wait(1.0)
        return original()

    monkeypatch.setattr(store, "snapshot", slow_snapshot)
    ticks = 0
    finished = False

    async def ticker() -> None:
        nonlocal ticks
        while not finished:
            ticks += 1
            await asyncio.sleep(0)

    timer = threading.Timer(0.05, release.set)
    timer.start()
    ticker_task = asyncio.create_task(ticker())
    try:
        result = await adapter.dispatch(
            "project", {"action": "list_workspaces"}, _context(VirtualClock())
        )
    finally:
        finished = True
        await ticker_task
        timer.cancel()

    assert entered.is_set()
    assert result.outcome == "ok"
    assert ticks > 1


@pytest.mark.asyncio
async def test_late_public_view_refresh_cannot_overwrite_newer_workspace(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter, store = _adapter(tmp_path)
    store.create_managed("beta")
    store.select_workspace("alpha")
    original = store.public_context
    first_entered = threading.Event()
    release_first = threading.Event()
    calls = 0

    def delayed_first(*, pending_confirmation: bool) -> Any:
        nonlocal calls
        calls += 1
        context = original(pending_confirmation=pending_confirmation)
        if calls == 1:
            first_entered.set()
            release_first.wait(1.0)
        return context

    monkeypatch.setattr(store, "public_context", delayed_first)
    stale = asyncio.create_task(adapter._refresh_project_view())
    while not first_entered.is_set():
        await asyncio.sleep(0)
    store.select_workspace("beta")
    await adapter._refresh_project_view()
    release_first.set()
    await stale

    workspace_id, view = adapter.public_project_context(pending_confirmation=False)
    assert view.workspace_display_name == "beta"
    assert workspace_id == store.resolve_workspace("beta").workspace_id


@pytest.mark.asyncio
async def test_locked_registry_yields_bounded_state_busy_not_an_exception(tmp_path: Path) -> None:
    adapter, store = _adapter(tmp_path)
    ctx = _context(VirtualClock())

    with open(store.lock_path, "rb") as holder:
        fcntl.flock(holder.fileno(), fcntl.LOCK_EX)
        try:
            listed = await adapter.dispatch("project", {"action": "list_workspaces"}, ctx)
            proposal = await adapter.dispatch(
                "project", {"action": "select_workspace", "workspace": "alpha"}, ctx
            )
        finally:
            fcntl.flock(holder.fileno(), fcntl.LOCK_UN)

    assert listed.outcome == proposal.outcome == "failed"
    assert listed.content["code"] == proposal.content["code"] == "state_busy"
    assert adapter.confirmation.pending is False


@pytest.mark.asyncio
async def test_prepared_confirmation_survives_busy_view_refresh(tmp_path: Path) -> None:
    adapter, store = _adapter(tmp_path)
    ctx = _context(VirtualClock())

    def busy_view(*, pending_confirmation: bool) -> Any:
        raise ProjectStateError("state_busy")

    store.public_context = busy_view  # type: ignore[method-assign]
    proposal = await adapter.dispatch(
        "project", {"action": "select_workspace", "workspace": "alpha"}, ctx
    )

    assert proposal.outcome == "ok"
    assert proposal.content["code"] == "confirmation_required"
    assert adapter.confirmation.pending is True


@pytest.mark.asyncio
async def test_run_fails_closed_before_worker_and_restores_active_on_busy_context(
    tmp_path: Path,
) -> None:
    clock = VirtualClock(start=10.0)
    store = CodexProjectStore(
        tmp_path / "state",
        tmp_path / "managed",
        now=clock.now,
        id_factory=iter((f"identifier-{index:03d}" for index in range(100))).__next__,
    )
    workspace = store.create_managed("alpha")
    factory = _ProjectFactory()
    adapter = ProjectCodexAdapter(
        store=store,
        confirmation=ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce"),
        worker_factory=factory,
    )

    def busy_view(*, pending_confirmation: bool) -> Any:
        raise ProjectStateError("state_busy")

    store.public_context = busy_view  # type: ignore[method-assign]
    result = await adapter.dispatch(
        "project", {"action": "start_session", "work_order": "task"}, _context(clock)
    )

    assert result.outcome == "failed"
    assert result.content == {"op": "run", "error": "state_busy"}
    assert factory.calls == []
    assert store.snapshot().active_workspace_id == workspace.workspace_id
    assert store.list_sessions(workspace) == ()


@pytest.mark.asyncio
async def test_critical_provider_failure_rolls_back_before_worker_while_ui_is_advisory(
    tmp_path: Path,
) -> None:
    clock = VirtualClock(start=10.0)
    store = CodexProjectStore(
        tmp_path / "state",
        tmp_path / "managed",
        now=clock.now,
        id_factory=iter((f"identifier-{index:03d}" for index in range(100))).__next__,
    )
    workspace = store.create_managed("alpha")
    factory = _ProjectFactory()
    adapter = ProjectCodexAdapter(
        store=store,
        confirmation=ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce"),
        worker_factory=factory,
        on_project_view=lambda _view: (_ for _ in ()).throw(RuntimeError("UI failed")),
    )
    observed: list[tuple[str | None, str | None]] = []

    async def critical(workspace_id: str | None, view: PublicProjectView) -> None:
        observed.append((workspace_id, view.session_title))
        if view.session_title == "任务 1":
            raise RuntimeError("provider delivery proof mismatch")

    observe = getattr(adapter, "observe_project_context", None)
    assert callable(observe), "critical project-context observer is required"
    unsubscribe = observe(critical)
    try:
        result = await adapter.dispatch(
            "project", {"action": "start_session", "work_order": "must not run"}, _context(clock)
        )
    finally:
        unsubscribe()

    assert result.outcome == "failed"
    assert result.content == {"op": "run", "error": "context_delivery_failed"}
    assert factory.calls == []
    assert store.snapshot().active_workspace_id == workspace.workspace_id
    assert store.list_sessions(workspace) == ()
    assert observed == [(workspace.workspace_id, "任务 1"), (workspace.workspace_id, None)]


@pytest.mark.asyncio
async def test_critical_resume_failure_restores_previous_active_workspace_before_worker(
    tmp_path: Path,
) -> None:
    clock = VirtualClock(start=10.0)
    store = CodexProjectStore(
        tmp_path / "state",
        tmp_path / "managed",
        now=clock.now,
        id_factory=iter((f"identifier-{index:03d}" for index in range(100))).__next__,
    )
    alpha = store.create_managed("alpha")
    confirmation = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    factory = _ProjectFactory()
    adapter = ProjectCodexAdapter(
        store=store,
        confirmation=confirmation,
        worker_factory=factory,
    )
    first = await adapter.dispatch(
        "project",
        {"action": "start_session", "work_order": "first", "session": "Existing"},
        _context(clock),
    )
    assert first.outcome == "ok"
    saved = store.resolve_session(alpha.workspace_id, "Existing")
    other = store.begin_session(alpha.workspace_id, "Other")
    store.mark_session_ready(other.session_id, "thread-other")
    beta = store.create_managed("beta")
    observed: list[tuple[str | None, str | None]] = []
    reject_resume = True

    async def critical(workspace_id: str | None, view: PublicProjectView) -> None:
        nonlocal reject_resume
        observed.append((workspace_id, view.session_title))
        if reject_resume and view.session_title == "Existing":
            reject_resume = False
            raise RuntimeError("provider rejected resumed context")

    unsubscribe = adapter.observe_project_context(critical)
    proposal = confirmation.prepare(
        action="resume",
        workspace_display_name="alpha",
        workspace_id=alpha.workspace_id,
        session_title=saved.display_title,
        session_id=saved.session_id,
        work_order="must not reach worker",
        origin_ref="conversation:2",
    )
    assert confirmation.reserve_user_item(epoch=1, item_id="confirm-resume-barrier")
    confirmed = confirmation.accept_decision(
        epoch=1,
        item_id="confirm-resume-barrier",
        proposal_id=proposal.proposal_id,
        confirmed=True,
    )
    assert confirmed.operation is not None
    dispatched: list[Any] = []

    def dispatch(request: Any, *, reason: Any) -> RuntimeDispatchResult:
        dispatched.append((request, reason))
        return RuntimeDispatchResult(accepted=True, delegate_id="resume-barrier")

    assert (
        await adapter.commit_confirmed(
            confirmed.operation,
            origin_ref="conversation:2",
            runtime_dispatch=dispatch,
        )
    ).accepted
    try:
        result = await adapter.dispatch(
            "project",
            {"action": "execute_confirmed"},
            _context(
                clock,
                origin_ref="conversation:2",
                delegate_id="resume-barrier",
                private=dispatched[0][0].private,
            ),
        )
    finally:
        unsubscribe()

    assert result.content == {"op": "run", "error": "context_delivery_failed"}
    assert len(factory.calls) == 1
    assert store.snapshot().active_workspace_id == beta.workspace_id
    assert store.resolve_workspace("alpha").active_session_id == other.session_id
    assert observed == [
        (alpha.workspace_id, "Existing"),
        (beta.workspace_id, None),
    ]


@pytest.mark.asyncio
async def test_critical_confirmed_create_failure_republishes_prior_state(
    tmp_path: Path,
) -> None:
    clock = VirtualClock(start=10.0)
    store = CodexProjectStore(
        tmp_path / "state",
        tmp_path / "managed",
        now=clock.now,
        id_factory=iter((f"identifier-{index:03d}" for index in range(100))).__next__,
    )
    alpha = store.create_managed("alpha")
    confirmation = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    factory = _ProjectFactory()
    adapter = ProjectCodexAdapter(
        store=store,
        confirmation=confirmation,
        worker_factory=factory,
    )
    observed: list[tuple[str | None, str | None]] = []
    reject_create = True

    async def critical(workspace_id: str | None, view: PublicProjectView) -> None:
        nonlocal reject_create
        observed.append((workspace_id, view.workspace_display_name))
        if reject_create and view.workspace_display_name == "beta":
            reject_create = False
            raise RuntimeError("provider rejected created workspace context")

    unsubscribe = adapter.observe_project_context(critical)
    proposal = await adapter.dispatch(
        "project",
        {"action": "create_workspace", "workspace": "beta", "work_order": "must not run"},
        _context(clock, origin_ref="conversation:2"),
    )
    assert confirmation.reserve_user_item(epoch=1, item_id="confirm-create-barrier")
    confirmed = confirmation.accept_decision(
        epoch=1,
        item_id="confirm-create-barrier",
        proposal_id=proposal.content["proposal_id"],
        confirmed=True,
    )
    assert confirmed.operation is not None
    dispatched: list[Any] = []

    def dispatch(request: Any, *, reason: Any) -> RuntimeDispatchResult:
        dispatched.append((request, reason))
        return RuntimeDispatchResult(accepted=True, delegate_id="create-barrier")

    assert (
        await adapter.commit_confirmed(
            confirmed.operation,
            origin_ref="conversation:2",
            runtime_dispatch=dispatch,
        )
    ).accepted
    try:
        result = await adapter.dispatch(
            "project",
            {"action": "execute_confirmed"},
            _context(
                clock,
                origin_ref="conversation:2",
                delegate_id="create-barrier",
                private=dispatched[0][0].private,
            ),
        )
    finally:
        unsubscribe()

    assert result.content == {"op": "run", "error": "context_delivery_failed"}
    assert factory.calls == []
    assert [item.display_name for item in store.list_workspaces()] == ["alpha"]
    assert store.snapshot().active_workspace_id == alpha.workspace_id
    assert observed[-1] == (alpha.workspace_id, "alpha")


@pytest.mark.asyncio
async def test_committed_select_rolls_back_when_critical_context_is_busy(
    tmp_path: Path,
) -> None:
    adapter, store = _adapter(tmp_path)
    beta = store.create_managed("beta")
    alpha = store.resolve_workspace("alpha")
    controller = adapter.confirmation
    proposal = controller.prepare(
        action="select",
        workspace_display_name="alpha",
        workspace_id=alpha.workspace_id,
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="conversation:1",
    )
    assert controller.reserve_user_item(epoch=1, item_id="user-1")
    outcome = controller.accept_decision(
        epoch=1,
        item_id="user-1",
        proposal_id=proposal.proposal_id,
        confirmed=True,
    )
    assert outcome.operation is not None

    def busy_view(*, pending_confirmation: bool) -> Any:
        raise ProjectStateError("state_busy")

    store.public_context = busy_view  # type: ignore[method-assign]
    committed = await adapter.commit_confirmed(
        outcome.operation,
        origin_ref="conversation:1",
        runtime_dispatch=lambda request, *, reason: RuntimeDispatchResult(
            accepted=True, delegate_id="unused"
        ),
    )

    assert committed == ProjectCommitResult(False, "state_busy")
    assert store.snapshot().active_workspace_id == beta.workspace_id


@pytest.mark.parametrize("change", ("identity", "boundary"))
@pytest.mark.asyncio
async def test_confirmed_select_rejects_workspace_replacement(
    tmp_path: Path,
    change: str,
) -> None:
    adapter, store = _adapter(tmp_path)
    original = store.resolve_workspace("alpha")
    proposal = await adapter.dispatch(
        "project",
        {"action": "select_workspace", "workspace": "alpha"},
        _context(VirtualClock()),
    )
    assert proposal.content["code"] == "confirmation_required"
    assert adapter.confirmation.reserve_user_item(epoch=1, item_id="confirm-select")
    confirmed = adapter.confirmation.accept_decision(
        epoch=1,
        item_id="confirm-select",
        proposal_id=proposal.content["proposal_id"],
        confirmed=True,
    )
    assert confirmed.operation is not None

    if change == "identity":
        assert store.rollback_managed_create(original.workspace_id)
        survivor = store.create_managed("alpha")
    else:
        survivor = store.create_managed("beta")
        original_path = Path(original.canonical_path)
        original_path.rename(tmp_path / "original-alpha")
        replacement = tmp_path / "replacement-alpha"
        replacement.mkdir()
        original_path.symlink_to(replacement, target_is_directory=True)

    committed = await adapter.commit_confirmed(
        confirmed.operation,
        origin_ref="conversation:1",
        runtime_dispatch=lambda request, *, reason: RuntimeDispatchResult(
            accepted=True, delegate_id="unused"
        ),
    )

    assert committed == ProjectCommitResult(False, "workspace_boundary_changed")
    assert store.snapshot().active_workspace_id == survivor.workspace_id


@pytest.mark.asyncio
async def test_session_listing_shows_the_most_recent_sessions_first(tmp_path: Path) -> None:
    clock = VirtualClock(start=1.0)
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
        worker_factory=lambda *_args, **_kwargs: _UnusedWorker(),
    )
    for index in range(21):
        clock.advance_to(float(index + 2))
        session = store.begin_session(workspace.workspace_id, f"task-{index:02d}")
        store.mark_session_ready(session.session_id, f"thread-{index:02d}")

    listed = await adapter.dispatch("project", {"action": "list_sessions"}, _context(clock))

    titles = [item["session"] for item in listed.content["sessions"]]
    assert len(titles) == 20
    assert titles[0] == "task-20"
    assert "task-00" not in titles


@pytest.mark.asyncio
async def test_workspace_listing_is_capped_at_twenty_most_recent(tmp_path: Path) -> None:
    adapter, store = _adapter(tmp_path)
    for index in range(21):
        store.create_managed(f"workspace-{index:02d}")

    listed = await adapter.dispatch(
        "project", {"action": "list_workspaces"}, _context(VirtualClock())
    )

    assert len(listed.content["workspaces"]) == 20


@pytest.mark.asyncio
async def test_unbound_capability_is_rejected_and_failed_confirmed_create_rolls_back(
    tmp_path: Path,
) -> None:
    clock = VirtualClock(start=10.0)
    store = CodexProjectStore(
        tmp_path / "state",
        tmp_path / "managed",
        now=clock.now,
        id_factory=iter((f"identifier-{index:03d}" for index in range(100))).__next__,
    )
    alpha = store.create_managed("alpha")
    adapter = ProjectCodexAdapter(
        store=store,
        confirmation=ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce"),
        worker_factory=lambda _workspace, _home, resume, on_ready: _NeverReadyWorker(
            resume or "missing", on_ready
        ),
    )
    views: list[PublicProjectView] = []
    adapter.observe_project_view(views.append)
    operation = ConfirmedProjectOperation(
        action="create",
        workspace_display_name="beta",
        workspace_id=None,
        session_title=None,
        session_id=None,
        work_order="build it",
        origin_ref="conversation:1",
        proposal_id="nonce",
        nonce="nonce",
    )

    result = await adapter.dispatch(
        "project",
        {"action": "execute_confirmed"},
        _context(clock, private=operation),
    )

    assert result.outcome == "failed"
    assert result.content == {"error": "confirmation_binding_mismatch", "op": "project"}
    proposal = adapter.confirmation.prepare(
        action="create",
        workspace_display_name="beta",
        workspace_id=None,
        session_title="Initial",
        session_id=None,
        work_order="build it",
        origin_ref="conversation:1",
    )
    assert adapter.confirmation.reserve_user_item(epoch=1, item_id="confirm-create")
    confirmed = adapter.confirmation.accept_decision(
        epoch=1,
        item_id="confirm-create",
        proposal_id=proposal.proposal_id,
        confirmed=True,
    )
    assert confirmed.operation is not None
    dispatched: list[Any] = []

    def dispatch(request: Any, *, reason: Any) -> RuntimeDispatchResult:
        dispatched.append((request, reason))
        return RuntimeDispatchResult(accepted=True, delegate_id="delegate-create")

    committed = await adapter.commit_confirmed(
        confirmed.operation,
        origin_ref="conversation:1",
        runtime_dispatch=dispatch,
    )
    failed = await adapter.dispatch(
        "project",
        {"action": "execute_confirmed"},
        _context(clock, delegate_id="delegate-create", private=dispatched[0][0].private),
    )

    assert committed.accepted is True
    assert failed.outcome == "failed"
    snapshot = store.snapshot()
    assert [item.display_name for item in snapshot.workspaces] == ["alpha"]
    assert snapshot.active_workspace_id == alpha.workspace_id
    assert views[-1] == PublicProjectView(
        workspace_display_name="alpha",
        session_title=None,
        pending_confirmation=False,
    )
    assert sorted(path.name for path in (tmp_path / "managed").iterdir()) == [
        Path(alpha.canonical_path).name
    ]


@pytest.mark.asyncio
async def test_aclose_releases_owner_lock_for_successor(tmp_path: Path) -> None:
    clock = VirtualClock()
    store = CodexProjectStore(
        tmp_path / "state",
        tmp_path / "managed",
        now=clock.now,
        id_factory=iter((f"identifier-{index:03d}" for index in range(100))).__next__,
        recover_starting=True,
    )
    adapter = ProjectCodexAdapter(
        store=store,
        confirmation=ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce"),
        worker_factory=lambda *_args, **_kwargs: _UnusedWorker(),
    )

    await adapter.aclose()

    successor = CodexProjectStore(
        tmp_path / "state",
        tmp_path / "managed",
        recover_starting=True,
    )
    successor.close()
