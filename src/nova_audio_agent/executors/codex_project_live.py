"""Named Codex workspaces, persistent Sessions, and one compact project tool."""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Protocol

from nova_audio_agent.events import WakeReason
from nova_audio_agent.executors.codex import CODEX_POLICY, _failure
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


_PROJECT_FIELDS = {
    "workspace": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80,
        "description": "create/select 必填；list_sessions/resume 可选；start_session 必须省略",
    },
    "session": {"type": "string", "minLength": 1, "maxLength": 120},
    "work_order": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4000,
        "description": "start_session 和 resume_session 必填；create_workspace 可选",
    },
}


def _project_variant(
    action: str,
    fields: tuple[str, ...],
    required: tuple[str, ...] = (),
) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": [action]},
            **{name: _PROJECT_FIELDS[name] for name in fields},
        },
        "required": ["action", *required],
        "additionalProperties": False,
    }


PROJECT = OpSpec(
    name="project",
    description=(
        "管理 Workspace 和 Session。严格按 action 选择字段：start_session 只能在当前 "
        "Workspace 运行且不得传 workspace；start_session 和 resume_session 都必须传完整 "
        "work_order。"
    ),
    params={
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": [
                    "list_workspaces",
                    "create_workspace",
                    "select_workspace",
                    "list_sessions",
                    "start_session",
                    "resume_session",
                ],
            },
            **_PROJECT_FIELDS,
        },
        "required": ["action"],
        "additionalProperties": False,
        "oneOf": [
            _project_variant("list_workspaces", ()),
            _project_variant("create_workspace", ("workspace",), ("workspace",)),
            _project_variant(
                "create_workspace",
                ("workspace", "session", "work_order"),
                ("workspace", "work_order"),
            ),
            _project_variant("select_workspace", ("workspace",), ("workspace",)),
            _project_variant("list_sessions", ("workspace",)),
            _project_variant("start_session", ("session", "work_order"), ("work_order",)),
            _project_variant(
                "resume_session",
                ("workspace", "session", "work_order"),
                ("work_order",),
            ),
        ],
    },
    readonly=False,
    deadline_budget=600.0,
    sensitive_params=("work_order",),
)

# Compatibility for Python importers; the project manifest no longer exposes
# a standalone run tool.
PROJECT_RUN = PROJECT

CONFIRM_PROJECT_ACTION = OpSpec(
    name="confirm_project_action",
    description=(
        "当前有待确认项目操作时，用户明确同意或明确拒绝都必须调用；同意传 "
        "confirmed=true，拒绝、取消或暂缓传 confirmed=false，不得只口头回应"
    ),
    params={
        "type": "object",
        "properties": {
            "proposal_id": {"type": "string", "minLength": 1, "maxLength": 128},
            "confirmed": {"type": "boolean"},
        },
        "required": ["proposal_id", "confirmed"],
        "additionalProperties": False,
    },
    readonly=False,
    deadline_budget=10.0,
    sync_result=True,
)

CODEX_PROJECT_LIVE_MANIFEST = ExecutorManifest(
    name="codex",
    ops=(PROJECT, CONFIRM_PROJECT_ACTION, STEER, STATUS),
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


async def _complete_sync(operation: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Run filesystem work off-loop and join it before propagating cancellation."""

    task = asyncio.create_task(asyncio.to_thread(operation, *args, **kwargs))
    cancelled: asyncio.CancelledError | None = None
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError as failure:
            if cancelled is None:
                cancelled = failure
        except BaseException:
            break
    try:
        result = task.result()
    except BaseException:
        if cancelled is not None:
            raise cancelled from None
        raise
    if cancelled is not None:
        raise cancelled
    return result


class ProjectCodexAdapter(CodexLiveAdapter):
    """Keep one global run slot while selecting a worker per immutable project binding."""

    manifest = CODEX_PROJECT_LIVE_MANIFEST

    def __init__(
        self,
        *,
        store: CodexProjectStore,
        confirmation: ProjectConfirmationController,
        worker_factory: ProjectWorkerFactory,
        on_project_view: Callable[[PublicProjectView], Awaitable[None] | None] | None = None,
    ) -> None:
        super().__init__(_NullWorker())
        self.store = store
        self.confirmation = confirmation
        self._worker_factory = worker_factory
        self._project_view_observers: set[Callable[[PublicProjectView], Awaitable[None] | None]] = (
            set()
        )
        self._project_context_observers: set[
            Callable[[str | None, PublicProjectView], Awaitable[None] | None]
        ] = set()
        if on_project_view is not None:
            self._project_view_observers.add(on_project_view)
        (
            self._public_workspace_id,
            self._public_project_view,
        ) = store.public_context(pending_confirmation=confirmation.pending)
        self._project_view_refresh_seq = 0
        self._confirmed_bindings: dict[int, tuple[ConfirmedProjectOperation, str, str]] = {}

    async def dispatch(
        self,
        op: str,
        request: dict[str, Any],
        ctx: DispatchContext,
    ) -> Handoff:
        private_operation = getattr(ctx.delegate, "private", None)
        if private_operation is not None:
            if op != "project" or request != {"action": "execute_confirmed"}:
                return _failure("invalid_operation", op)
            if type(private_operation) is not ConfirmedProjectOperation:
                return _failure("confirmation_binding_mismatch", op)
            binding = self._confirmed_bindings.get(id(private_operation))
            if (
                binding is None
                or binding[0] is not private_operation
                or binding[1] != ctx.delegate.delegate_id
                or binding[2] != ctx.delegate.origin_ref
            ):
                return _failure("confirmation_binding_mismatch", op)
            del self._confirmed_bindings[id(private_operation)]
            if self._run_lock.locked():
                return _failure("busy", "project")
            await self._run_lock.acquire()
            try:
                return await self._run_confirmed(private_operation, ctx)
            finally:
                self._run_lock.release()
        if op in {"status", "steer"}:
            return await super().dispatch(op, request, ctx)
        if op != "project":
            return _failure("unknown_op", op)
        result = await self._dispatch_project(request, ctx)
        await self._refresh_project_view_tolerant()
        return result

    async def _dispatch_start_session(
        self, work_order: str, session_title: str | None, ctx: DispatchContext
    ) -> Handoff:
        if self._run_lock.locked():
            return _failure("busy", "project")
        await self._run_lock.acquire()
        try:
            return await self._run_new(work_order, session_title, ctx)
        finally:
            self._run_lock.release()

    async def _dispatch_project(self, request: dict[str, Any], ctx: DispatchContext) -> Handoff:
        normalized = _normalize_project_request(request)
        if normalized is None:
            return _failure("invalid_params", "project")
        action = normalized["action"]
        workspace_name = normalized.get("workspace")
        session_title = normalized.get("session")
        work_order = normalized.get("work_order")
        try:
            if action == "list_workspaces":
                snapshot = await _complete_sync(self.store.snapshot)
                return _project_ok(
                    code="listed",
                    workspaces=[
                        {
                            "workspace": item.display_name,
                            "active": item.workspace_id == snapshot.active_workspace_id,
                        }
                        for item in _most_recent(snapshot.workspaces)
                    ],
                )
            if action == "list_sessions":
                workspace = await _complete_sync(self.store.resolve_workspace, workspace_name)
                sessions = await _complete_sync(self.store.list_sessions, workspace)
                return _project_ok(
                    code="sessions_listed",
                    workspace=workspace.display_name,
                    sessions=[
                        {
                            "session": item.display_title,
                            "state": item.state,
                            "active": item.session_id == workspace.active_session_id,
                        }
                        for item in _most_recent(sessions)
                    ],
                )
            if action == "start_session":
                assert work_order is not None
                return await self._dispatch_start_session(work_order, session_title, ctx)
            if action == "create_workspace":
                assert workspace_name is not None
                workspace_name = await _complete_sync(
                    self.store.validate_managed_create, workspace_name
                )
                workspace = None
                resolved_session = None
            else:
                workspace = await _complete_sync(self.store.resolve_workspace, workspace_name)
                resolved_session = (
                    await _complete_sync(
                        self.store.resolve_session,
                        workspace.workspace_id,
                        session_title,
                    )
                    if action == "resume_session"
                    else None
                )
                if resolved_session is not None and resolved_session.state != "ready":
                    raise ProjectStateError("session_unavailable")
            proposal = self.confirmation.prepare(
                action={
                    "create_workspace": "create",
                    "select_workspace": "select",
                    "resume_session": "resume",
                }[action],
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
            return await self._lookup_failure(failure.code)
        return _project_ok(
            code="confirmation_required",
            proposal_id=proposal.proposal_id,
            expires_at=proposal.expires_at,
            action=action,
            workspace=proposal.workspace_display_name,
            session=proposal.session_title,
            confirmation_prompt=proposal.confirmation_prompt,
        )

    async def _lookup_failure(self, code: str) -> Handoff:
        content: dict[str, Any] = {"op": "project", "code": code}
        if code == "workspace_not_found":
            # Candidate names are a courtesy; a busy or failing registry read
            # must not turn the bounded failure into an adapter exception.
            try:
                workspaces = await _complete_sync(self.store.list_workspaces)
            except ProjectStateError:
                workspaces = ()
            content["candidates"] = [item.display_name for item in _most_recent(workspaces)]
        return Handoff(outcome="failed", trust="trusted_system", content=content)

    async def _run_new(
        self,
        work_order: str,
        session_title: str | None,
        ctx: DispatchContext,
    ) -> Handoff:
        try:
            workspace = await _complete_sync(self.store.resolve_workspace, None)
            return await self._run_bound(workspace, None, session_title, work_order, ctx)
        except ProjectStateError as failure:
            return _failure(failure.code, "run")

    async def _run_confirmed(
        self,
        operation: ConfirmedProjectOperation,
        ctx: DispatchContext,
    ) -> Handoff:
        work_order = operation.work_order
        if work_order is None:
            return _failure("invalid_operation", "project")
        try:
            if operation.action == "create":
                previous_workspace = await self._active_workspace_or_none()
                workspace = await _complete_sync(
                    self.store.create_managed, operation.workspace_display_name
                )
                if operation.work_order is None:
                    await self._refresh_project_view_tolerant()
                    return _project_ok(code="created", workspace=workspace.display_name)
                try:
                    result = await self._run_bound(
                        workspace, None, operation.session_title, operation.work_order, ctx
                    )
                except BaseException:
                    await self._rollback_confirmed_create(
                        workspace.workspace_id, previous_workspace
                    )
                    raise
                if result.outcome != "ok":
                    await self._rollback_confirmed_create(
                        workspace.workspace_id, previous_workspace
                    )
                return result
            assert operation.workspace_id is not None
            workspace = await _complete_sync(
                self.store.resolve_workspace, operation.workspace_display_name
            )
            if workspace.workspace_id != operation.workspace_id:
                raise ProjectStateError("workspace_boundary_changed")
            if operation.action == "select":
                previous = await _complete_sync(self.store.resolve_workspace, None)
                selected = await _complete_sync(self.store.select_workspace, workspace.display_name)
                try:
                    await self._refresh_project_context_barrier()
                except ProjectStateError:
                    await _complete_sync(
                        self.store.select_workspace_exact,
                        previous.display_name,
                        previous.workspace_id,
                    )
                    await self._refresh_project_context_barrier()
                    raise
                return _project_ok(code="selected", workspace=selected.display_name)
            assert operation.session_id is not None
            session = await _complete_sync(
                self.store.resolve_session,
                workspace.workspace_id,
                operation.session_title,
            )
            if session.session_id != operation.session_id or session.codex_thread_id is None:
                raise ProjectStateError("session_workspace_mismatch")
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
        path = await _complete_sync(self.store.revalidate_workspace, workspace.workspace_id)
        resume_rollback = None
        session = resumed or await _complete_sync(
            self.store.begin_session, workspace.workspace_id, session_title
        )
        if resumed is not None:
            session, resume_rollback = await _complete_sync(
                self.store.activate_session_for_resume,
                workspace.workspace_id,
                resumed.session_id,
            )
        ready = False
        binding_invalid = False
        reported_thread_id: str | None = None
        result: Handoff | None = None

        def on_thread_ready(thread_id: str) -> None:
            nonlocal binding_invalid, ready, reported_thread_id
            if resumed is not None:
                if thread_id != resumed.codex_thread_id:
                    binding_invalid = True
                    raise ProjectStateError("session_thread_mismatch")
                ready = True
            reported_thread_id = thread_id

        try:
            await self._refresh_project_context_barrier()
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
            if resumed is None and reported_thread_id is not None and not binding_invalid:
                try:
                    await _complete_sync(
                        self.store.mark_session_ready,
                        session.session_id,
                        reported_thread_id,
                        wait=True,
                    )
                    ready = True
                except ProjectStateError:
                    ready = False
            if not ready:
                state_changed = False
                if resumed is None:
                    state_changed = await _complete_sync(
                        self.store.rollback_session_start,
                        session.session_id,
                        wait=True,
                    )
                elif binding_invalid or (
                    result is not None and result.content.get("code") == "resume_unavailable"
                ):
                    await _complete_sync(
                        self.store.mark_session_unavailable,
                        session.session_id,
                        wait=True,
                    )
                    state_changed = True
                elif result is None and resume_rollback is not None:
                    await _complete_sync(
                        self.store.rollback_session_resume,
                        resume_rollback,
                        wait=True,
                    )
                    state_changed = True
                if state_changed:
                    await self._refresh_project_context_barrier()

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
            previous: WorkspaceRecord | None = None
            committed_workspace: WorkspaceRecord | None = None
            try:
                previous = await self._active_workspace_or_none()
                if operation.action == "create":
                    committed_workspace = await _complete_sync(
                        self.store.create_managed, operation.workspace_display_name
                    )
                elif operation.action == "select" and operation.workspace_id is not None:
                    committed_workspace = await _complete_sync(
                        self.store.select_workspace_exact,
                        operation.workspace_display_name,
                        operation.workspace_id,
                    )
                else:
                    return ProjectCommitResult(False, "invalid_operation")
            except ProjectStateError as failure:
                return ProjectCommitResult(False, failure.code)
            try:
                await self._refresh_project_context_barrier()
            except ProjectStateError as failure:
                assert committed_workspace is not None
                if operation.action == "create":
                    rolled_back = await _complete_sync(
                        self.store.rollback_managed_create,
                        committed_workspace.workspace_id,
                        wait=True,
                    )
                    if rolled_back and previous is not None:
                        await _complete_sync(
                            self.store.select_workspace_exact,
                            previous.display_name,
                            previous.workspace_id,
                        )
                else:
                    assert previous is not None
                    await _complete_sync(
                        self.store.select_workspace_exact,
                        previous.display_name,
                        previous.workspace_id,
                    )
                try:
                    await self._refresh_project_context_barrier()
                except ProjectStateError as recovery_failure:
                    return ProjectCommitResult(False, recovery_failure.code)
                return ProjectCommitResult(False, failure.code)
            return ProjectCommitResult(True, "committed")
        normalized_request = _normalize_project_request(
            {"action": "start_session", "work_order": work_order}
        )
        if normalized_request is None or normalized_request["work_order"] != work_order:
            return ProjectCommitResult(False, "invalid_operation")
        if self._run_lock.locked():
            return ProjectCommitResult(False, "busy")
        admission = runtime_dispatch(
            DelegateRequest(
                executor="codex",
                op="project",
                request={"action": "execute_confirmed"},
                origin_ref=origin_ref,
                private=operation,
            ),
            reason=WakeReason(kind="realtime_tool", priority=100, routing_class="user_awaited"),
        )
        if not admission.accepted or admission.delegate_id is None:
            return ProjectCommitResult(False, "runtime_rejected")
        self._confirmed_bindings[id(operation)] = (
            operation,
            admission.delegate_id,
            origin_ref,
        )
        return ProjectCommitResult(True, "accepted", admission.delegate_id)

    async def _active_workspace_or_none(self) -> WorkspaceRecord | None:
        try:
            return await _complete_sync(self.store.resolve_workspace, None)
        except ProjectStateError as failure:
            if failure.code == "workspace_not_found":
                return None
            raise

    async def _load_project_context(self) -> tuple[str | None, PublicProjectView] | None:
        self._project_view_refresh_seq += 1
        refresh_seq = self._project_view_refresh_seq
        workspace_id, stored_view = await _complete_sync(
            self.store.public_context,
            pending_confirmation=False,
        )
        if refresh_seq != self._project_view_refresh_seq:
            return None
        self._public_workspace_id = workspace_id
        self._public_project_view = stored_view
        return workspace_id, self.public_project_view(
            pending_confirmation=self.confirmation.pending
        )

    async def _refresh_project_view(self) -> None:
        context = await self._load_project_context()
        if context is not None:
            await self._publish_project_view(context[1])

    async def _refresh_project_context_barrier(self) -> None:
        context = await self._load_project_context()
        if context is None:
            raise ProjectStateError("context_delivery_failed")
        workspace_id, view = context
        await self._publish_project_view(view)
        for observer in tuple(self._project_context_observers):
            try:
                result = observer(workspace_id, view)
                if inspect.isawaitable(result):
                    await result
            except Exception:
                raise ProjectStateError("context_delivery_failed") from None

    async def _refresh_project_view_tolerant(self) -> None:
        """Refresh the cached view, tolerating a transiently locked registry.

        `state_busy` only means another owner-side process held the flock for
        an instant; the operation that preceded the refresh already committed,
        so the stale cached view must not convert into a spoken failure.
        """
        try:
            await self._refresh_project_view()
        except ProjectStateError as failure:
            if failure.code != "state_busy":
                raise
            await self._publish_project_view(
                self.public_project_view(pending_confirmation=self.confirmation.pending)
            )

    async def _rollback_confirmed_create(
        self,
        workspace_id: str,
        previous_workspace: WorkspaceRecord | None,
    ) -> None:
        """Remove an empty failed create and critically publish the restored state.

        The store refuses to remove a workspace that gained sessions or files,
        so this can never destroy user work. A recovery failure must propagate
        and keep project work fenced until provider ownership is proven again.
        """
        rolled_back = await _complete_sync(
            self.store.rollback_managed_create, workspace_id, wait=True
        )
        if rolled_back:
            if previous_workspace is not None:
                await _complete_sync(
                    self.store.select_workspace_exact,
                    previous_workspace.display_name,
                    previous_workspace.workspace_id,
                )
            await self._refresh_project_context_barrier()

    async def aclose(self) -> None:
        try:
            await super().aclose()
        finally:
            self.store.close()

    def public_project_view(self, *, pending_confirmation: bool) -> PublicProjectView:
        if not pending_confirmation:
            return replace(
                self._public_project_view,
                pending_confirmation=False,
                pending_action=None,
                pending_workspace_display_name=None,
                pending_session_title=None,
                pending_expires_in_seconds=None,
            )
        confirmation = self.confirmation.view
        return replace(
            self._public_project_view,
            pending_confirmation=True,
            pending_action=confirmation.pending_action,
            pending_workspace_display_name=confirmation.pending_workspace_display_name,
            pending_session_title=confirmation.pending_session_title,
            pending_expires_in_seconds=confirmation.pending_expires_in_seconds,
        )

    def public_project_context(
        self, *, pending_confirmation: bool
    ) -> tuple[str | None, PublicProjectView]:
        return (
            self._public_workspace_id,
            self.public_project_view(pending_confirmation=pending_confirmation),
        )

    def observe_project_view(
        self, observer: Callable[[PublicProjectView], Awaitable[None] | None]
    ) -> Callable[[], None]:
        self._project_view_observers.add(observer)
        return lambda: self._project_view_observers.discard(observer)

    def observe_project_context(
        self,
        observer: Callable[[str | None, PublicProjectView], Awaitable[None] | None],
    ) -> Callable[[], None]:
        self._project_context_observers.add(observer)
        return lambda: self._project_context_observers.discard(observer)

    async def _publish_project_view(self, view: PublicProjectView) -> None:
        for observer in tuple(self._project_view_observers):
            try:
                result = observer(view)
                if inspect.isawaitable(result):
                    await result
            except Exception:
                pass


def _normalize_project_request(request: object) -> dict[str, str] | None:
    if type(request) is not dict or not set(request).issubset(
        {"action", "workspace", "session", "work_order"}
    ):
        return None
    action = request.get("action")
    expected = {
        "list_workspaces": {"action"},
        "create_workspace": {"action", "workspace"},
        "select_workspace": {"action", "workspace"},
        "list_sessions": {"action"},
        "start_session": {"action", "work_order"},
        "resume_session": {"action", "work_order"},
    }
    if action not in expected:
        return None
    allowed = set(expected[action])
    if action == "create_workspace":
        allowed.update(("session", "work_order"))
    elif action == "list_sessions":
        allowed.add("workspace")
    elif action == "start_session":
        allowed.add("session")
    elif action == "resume_session":
        allowed.update(("workspace", "session"))
    if set(request) - allowed or not expected[action].issubset(request):
        return None
    if action == "create_workspace" and ("session" in request and "work_order" not in request):
        return None
    result = {"action": action}
    for name, limit in (
        ("workspace", 80),
        ("session", 120),
        ("work_order", 4000),
    ):
        if name not in request:
            continue
        value = request[name]
        if type(value) is not str or not value.strip() or len(value) > limit:
            return None
        result[name] = value.strip()
    return result


def _most_recent(items: Any) -> list[Any]:
    # Listings answer "which one did I just use"; the registry snapshot is
    # oldest-first, so slicing it directly would hide every recent record once
    # more than 20 exist. Stable sort keeps creation order for equal stamps.
    return sorted(items, key=lambda item: (-item.last_used_at, item.created_at))[:20]


def _project_ok(*, code: str, **content: Any) -> Handoff:
    return Handoff(
        outcome="ok",
        trust="trusted_system",
        content={"op": "project", "code": code, **content},
    )
