"""Named Codex workspaces, persistent Sessions, and one compact project tool."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol

from nova_audio_agent.events import WakeReason
from nova_audio_agent.executors.codex import CODEX_POLICY, _failure, _normalize_run_request
from nova_audio_agent.executors.codex_live import STATUS, STEER, CodexLiveAdapter, CodexLiveWorker
from nova_audio_agent.executors.codex_projects import (
    CodexProjectStore,
    ProjectSessionRecord,
    ProjectStateError,
    PublicProjectView,
    WorkspaceRecord,
)
from nova_audio_agent.ports import (
    DelegateRequest,
    DispatchContext,
    ExecutorManifest,
    Handoff,
    OpSpec,
)
from nova_audio_agent.realtime.project_confirmation import (
    ConfirmedProjectOperation,
    ProjectConfirmationController,
)

PROJECT_RUN = OpSpec(
    name="run",
    description="在当前工作区启动一个新的 Codex Session 执行工作单",
    params={
        "type": "object",
        "properties": {
            "work_order": {"type": "string", "minLength": 1, "maxLength": 4000},
            "session": {"type": "string", "minLength": 1, "maxLength": 120},
        },
        "required": ["work_order"],
        "additionalProperties": False,
    },
    readonly=False,
    deadline_budget=600.0,
    sensitive_params=("work_order",),
)

PROJECT = OpSpec(
    name="project",
    description="列出、创建或切换工作区，以及列出或继续其中的 Session",
    params={
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["list", "create", "select", "sessions", "resume"],
            },
            "workspace": {"type": "string", "minLength": 1, "maxLength": 80},
            "session": {"type": "string", "minLength": 1, "maxLength": 120},
            "work_order": {"type": "string", "minLength": 1, "maxLength": 4000},
        },
        "required": ["action"],
        "additionalProperties": False,
    },
    readonly=False,
    deadline_budget=10.0,
    sensitive_params=("work_order",),
)

CODEX_PROJECT_LIVE_MANIFEST = ExecutorManifest(
    name="codex",
    ops=(PROJECT_RUN, PROJECT, STEER, STATUS),
    policy=CODEX_POLICY,
)


class ProjectWorkerFactory(Protocol):
    def __call__(
        self,
        workspace: Path,
        codex_home: Path,
        resume_thread_id: str | None,
        on_thread_ready: Callable[[str], None],
    ) -> CodexLiveWorker: ...


class RuntimeDispatch(Protocol):
    def __call__(self, request: DelegateRequest, *, reason: WakeReason) -> _DispatchAdmission: ...


class _DispatchAdmission(Protocol):
    accepted: bool
    delegate_id: str | None


@dataclass(frozen=True, slots=True)
class ProjectCommitResult:
    accepted: bool
    code: str
    delegate_id: str | None = None


class _NullWorker:
    async def prewarm(self, **_kwargs: Any) -> None:
        return None

    async def preflight(self, **_kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("workspace_not_selected")

    async def run(self, *_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("workspace_not_selected")

    async def steer(self, _instruction: str) -> Any:
        raise RuntimeError("no_active_turn")

    async def aclose(self) -> None:
        return None


class ProjectCodexAdapter(CodexLiveAdapter):
    """Keep one global run slot while selecting a worker per immutable project binding."""

    manifest = CODEX_PROJECT_LIVE_MANIFEST

    def __init__(
        self,
        *,
        store: CodexProjectStore,
        confirmation: ProjectConfirmationController,
        worker_factory: ProjectWorkerFactory,
        on_project_view: Callable[[PublicProjectView], None] | None = None,
    ) -> None:
        super().__init__(_NullWorker())
        self.store = store
        self.confirmation = confirmation
        self._worker_factory = worker_factory
        self._on_project_view = on_project_view

    async def dispatch(
        self,
        op: str,
        request: dict[str, Any],
        ctx: DispatchContext,
    ) -> Handoff:
        if op == "project":
            return self._dispatch_project(request, ctx)
        if op != "run":
            return await super().dispatch(op, request, ctx)
        normalized = _normalize_project_run(request)
        if normalized is None:
            return _failure("invalid_params", op)
        private = getattr(ctx.delegate, "private", None)
        if private is not None and type(private) is not ConfirmedProjectOperation:
            return _failure("confirmation_binding_mismatch", op)
        confirmed = private if type(private) is ConfirmedProjectOperation else None
        if confirmed is not None and normalized[0] != confirmed.work_order:
            return _failure("confirmation_binding_mismatch", op)
        if self._run_lock.locked():
            return _failure("busy", op)
        await self._run_lock.acquire()
        try:
            if confirmed is not None:
                assert confirmed.work_order is not None
                return await self._run_confirmed(confirmed, confirmed.work_order, ctx)
            return await self._run_new(normalized[0], normalized[1], ctx)
        finally:
            self._run_lock.release()

    def _dispatch_project(self, request: dict[str, Any], ctx: DispatchContext) -> Handoff:
        parsed = _parse_project_request(request)
        if parsed is None:
            return _failure("invalid_params", "project")
        action, workspace_name, session_title, work_order = parsed
        if action == "list":
            snapshot = self.store.snapshot()
            return _project_ok(
                code="listed",
                workspaces=[
                    {
                        "workspace": item.display_name,
                        "active": item.workspace_id == snapshot.active_workspace_id,
                    }
                    for item in snapshot.workspaces[:20]
                ],
            )
        try:
            if action == "sessions":
                workspace = self.store.resolve_workspace(workspace_name)
                return _project_ok(
                    code="sessions_listed",
                    workspace=workspace.display_name,
                    sessions=[
                        {
                            "session": item.display_title,
                            "state": item.state,
                            "active": item.session_id == workspace.active_session_id,
                        }
                        for item in self.store.list_sessions(workspace)[:20]
                    ],
                )
            if action == "create":
                workspace = None
                resolved_session = None
            else:
                workspace = self.store.resolve_workspace(workspace_name)
                resolved_session = (
                    self.store.resolve_session(workspace.workspace_id, session_title)
                    if action == "resume"
                    else None
                )
                if resolved_session is not None and resolved_session.state != "ready":
                    raise ProjectStateError("session_unavailable")
            proposal = self.confirmation.prepare(
                action=action,
                workspace_display_name=(
                    workspace_name if workspace is None else workspace.display_name
                ),
                workspace_id=None if workspace is None else workspace.workspace_id,
                session_title=(
                    session_title if resolved_session is None else resolved_session.display_title
                ),
                session_id=None if resolved_session is None else resolved_session.session_id,
                work_order=work_order,
                origin_ref=ctx.delegate.origin_ref,
            )
        except ProjectStateError as failure:
            return self._lookup_failure(failure.code)
        return _project_ok(
            code="confirmation_required",
            action=proposal.action,
            workspace=proposal.workspace_display_name,
            session=proposal.session_title,
            confirmation_prompt=proposal.confirmation_prompt,
        )

    def _lookup_failure(self, code: str) -> Handoff:
        content: dict[str, Any] = {"op": "project", "code": code}
        if code == "workspace_not_found":
            content["candidates"] = [
                item.display_name for item in self.store.list_workspaces()[:20]
            ]
        return Handoff(outcome="failed", trust="trusted_system", content=content)

    async def _run_new(
        self,
        work_order: str,
        session_title: str | None,
        ctx: DispatchContext,
    ) -> Handoff:
        try:
            workspace = self.store.resolve_workspace(None)
            return await self._run_bound(workspace, None, session_title, work_order, ctx)
        except ProjectStateError as failure:
            return _failure(failure.code, "run")

    async def _run_confirmed(
        self,
        operation: ConfirmedProjectOperation,
        work_order: str,
        ctx: DispatchContext,
    ) -> Handoff:
        try:
            if operation.action == "create":
                workspace = self.store.create_managed(operation.workspace_display_name)
                if operation.work_order is None:
                    return _project_ok(code="created", workspace=workspace.display_name)
                return await self._run_bound(
                    workspace, None, operation.session_title, operation.work_order, ctx
                )
            assert operation.workspace_id is not None
            workspace = self.store.resolve_workspace(operation.workspace_display_name)
            if workspace.workspace_id != operation.workspace_id:
                raise ProjectStateError("workspace_boundary_changed")
            if operation.action == "select":
                selected = self.store.select_workspace(workspace.display_name)
                return _project_ok(code="selected", workspace=selected.display_name)
            assert operation.session_id is not None
            session = self.store.resolve_session(workspace.workspace_id, operation.session_title)
            if session.session_id != operation.session_id or session.codex_thread_id is None:
                raise ProjectStateError("session_workspace_mismatch")
            self.store.activate_session(workspace.workspace_id, session.session_id)
            return await self._run_bound(workspace, session, None, work_order, ctx)
        except ProjectStateError as failure:
            return _failure(failure.code, "run")

    async def _run_bound(
        self,
        workspace: WorkspaceRecord,
        resumed: ProjectSessionRecord | None,
        session_title: str | None,
        work_order: str,
        ctx: DispatchContext,
    ) -> Handoff:
        path = self.store.revalidate_workspace(workspace.workspace_id)
        session = resumed or self.store.begin_session(workspace.workspace_id, session_title)
        self._publish_project_view()
        ready = False
        binding_invalid = False
        result: Handoff | None = None

        def on_thread_ready(thread_id: str) -> None:
            nonlocal binding_invalid, ready
            if resumed is not None:
                if thread_id != resumed.codex_thread_id:
                    binding_invalid = True
                    raise ProjectStateError("session_thread_mismatch")
            else:
                self.store.mark_session_ready(session.session_id, thread_id)
            ready = True
            self._publish_project_view()

        try:
            worker = self._worker_factory(
                path,
                self.store.codex_home(workspace),
                None if resumed is None else resumed.codex_thread_id,
                on_thread_ready,
            )
            self._worker = worker
            self._mark_prewarm_cold()
            result = await self._run(work_order, ctx)
            return result
        finally:
            if not ready:
                try:
                    if resumed is None:
                        self.store.rollback_session_start(session.session_id)
                    elif binding_invalid or (
                        result is not None and result.content.get("code") == "resume_unavailable"
                    ):
                        self.store.mark_session_unavailable(session.session_id)
                except ProjectStateError:
                    pass
                self._publish_project_view()

    async def commit_confirmed(
        self,
        operation: ConfirmedProjectOperation,
        *,
        origin_ref: str,
        runtime_dispatch: RuntimeDispatch,
    ) -> ProjectCommitResult:
        if not self.confirmation.claim_confirmed(operation):
            return ProjectCommitResult(False, "confirmation_invalid")
        work_order = operation.work_order
        if work_order is None:
            try:
                if operation.action == "create":
                    self.store.create_managed(operation.workspace_display_name)
                elif operation.action == "select":
                    self.store.select_workspace(operation.workspace_display_name)
                else:
                    return ProjectCommitResult(False, "invalid_operation")
            except ProjectStateError as failure:
                return ProjectCommitResult(False, failure.code)
            self._publish_project_view()
            return ProjectCommitResult(True, "committed")
        normalized_work_order = _normalize_run_request({"work_order": work_order})
        if normalized_work_order is None or normalized_work_order != work_order:
            return ProjectCommitResult(False, "invalid_operation")
        if self._run_lock.locked():
            return ProjectCommitResult(False, "busy")
        admission = runtime_dispatch(
            DelegateRequest(
                executor="codex",
                op="run",
                request={"work_order": work_order},
                origin_ref=origin_ref,
                private=operation,
            ),
            reason=WakeReason(kind="realtime_tool", priority=100, routing_class="user_awaited"),
        )
        if not admission.accepted or admission.delegate_id is None:
            return ProjectCommitResult(False, "runtime_rejected")
        return ProjectCommitResult(True, "accepted", admission.delegate_id)

    def _publish_project_view(self) -> None:
        if self._on_project_view is None:
            return
        try:
            self._on_project_view(
                self.store.public_view(pending_confirmation=self.confirmation.pending)
            )
        except Exception:
            pass


def _normalize_project_run(request: object) -> tuple[str, str | None] | None:
    if type(request) is not dict or not set(request).issubset({"work_order", "session"}):
        return None
    work_order = _normalize_run_request({"work_order": request.get("work_order")})
    session = request.get("session")
    if work_order is None:
        return None
    if session is not None and (
        type(session) is not str or not session.strip() or len(session) > 120
    ):
        return None
    return work_order, None if session is None else session.strip()


def _parse_project_request(
    request: object,
) -> (
    tuple[
        Literal["list", "create", "select", "sessions", "resume"],
        str | None,
        str | None,
        str | None,
    ]
    | None
):
    if type(request) is not dict or not set(request).issubset(
        {"action", "workspace", "session", "work_order"}
    ):
        return None
    action = request.get("action")
    workspace = request.get("workspace")
    session = request.get("session")
    work_order = request.get("work_order")
    expected = {
        "list": {"action"},
        "create": {"action", "workspace"},
        "select": {"action", "workspace"},
        "sessions": {"action"},
        "resume": {"action", "work_order"},
    }
    if action not in expected:
        return None
    allowed = set(expected[action])
    if action == "create":
        allowed.add("work_order")
    elif action == "sessions":
        allowed.add("workspace")
    elif action == "resume":
        allowed.update(("workspace", "session"))
    if set(request) - allowed or not expected[action].issubset(request):
        return None
    for value, limit in ((workspace, 80), (session, 120), (work_order, 4000)):
        if value is not None and (
            type(value) is not str or not value.strip() or len(value) > limit
        ):
            return None
    return (
        action,
        None if workspace is None else workspace.strip(),
        None if session is None else session.strip(),
        None if work_order is None else work_order.strip(),
    )


def _project_ok(*, code: str, **content: Any) -> Handoff:
    return Handoff(
        outcome="ok",
        trust="trusted_system",
        content={"op": "project", "code": code, **content},
    )
