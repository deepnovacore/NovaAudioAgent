"""Deterministic host confirmation for Codex project boundary changes."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, Protocol

from nova_audio_agent.clock import Clock

ProjectAction = Literal["create", "select", "resume"]
ConfirmationKind = Literal["confirmed", "cancelled", "invalid", "expired", "ignored"]
PROJECT_CONFIRMATION_TTL_SECONDS = 360.0


@dataclass(frozen=True, slots=True)
class ProjectProposal:
    action: ProjectAction
    workspace_display_name: str
    workspace_id: str | None
    session_title: str | None
    session_id: str | None
    work_order: str | None
    origin_ref: str
    proposal_id: str
    expires_at: float
    confirmation_prompt: str


class _ProposalLike(Protocol):
    action: ProjectAction
    workspace_display_name: str
    workspace_id: str | None
    session_title: str | None
    session_id: str | None
    work_order: str | None
    origin_ref: str
    proposal_id: str


@dataclass(frozen=True, slots=True)
class ConfirmedProjectOperation:
    action: ProjectAction
    workspace_display_name: str
    workspace_id: str | None
    session_title: str | None
    session_id: str | None
    work_order: str | None
    origin_ref: str
    proposal_id: str

    @classmethod
    def from_proposal(cls, proposal: _ProposalLike) -> ConfirmedProjectOperation:
        return cls(
            action=proposal.action,
            workspace_display_name=proposal.workspace_display_name,
            workspace_id=proposal.workspace_id,
            session_title=proposal.session_title,
            session_id=proposal.session_id,
            work_order=proposal.work_order,
            origin_ref=proposal.origin_ref,
            proposal_id=proposal.proposal_id,
        )


@dataclass(frozen=True, slots=True)
class ProjectConfirmationView:
    pending_confirmation: bool
    workspace_display_name: str | None = None
    session_title: str | None = None
    pending_action: Literal["create_workspace", "select_workspace", "resume_session"] | None = None
    pending_workspace_display_name: str | None = None
    pending_session_title: str | None = None
    pending_expires_in_seconds: float | None = None


@dataclass(frozen=True, slots=True)
class ConfirmationOutcome:
    kind: ConfirmationKind
    operation: ConfirmedProjectOperation | None = None
    response_text: str | None = None


class ProjectConfirmationController:
    """Own exactly one proposal, ASR reservation, and commit authority."""

    def __init__(
        self,
        *,
        clock: Clock,
        id_factory: Callable[[], str],
        on_change: Callable[[ProjectConfirmationView], None] | None = None,
    ) -> None:
        self._clock = clock
        self._id_factory = id_factory
        self._on_change = on_change
        self._proposal: ProjectProposal | None = None
        self._reserved: tuple[int, str] | None = None
        self._commit_authority: ConfirmedProjectOperation | None = None
        self._expiry_task: asyncio.Task[None] | None = None
        self._expiry_observers: list[Callable[[], None]] = []

    @property
    def view(self) -> ProjectConfirmationView:
        proposal = self._proposal if self.pending else None
        if proposal is None:
            return ProjectConfirmationView(pending_confirmation=False)
        return ProjectConfirmationView(
            pending_confirmation=True,
            workspace_display_name=proposal.workspace_display_name,
            session_title=proposal.session_title,
            pending_action={
                "create": "create_workspace",
                "select": "select_workspace",
                "resume": "resume_session",
            }[proposal.action],
            pending_workspace_display_name=proposal.workspace_display_name,
            pending_session_title=proposal.session_title,
            pending_expires_in_seconds=max(0.0, proposal.expires_at - self._clock.now()),
        )

    @property
    def pending(self) -> bool:
        return self._proposal is not None and not self._is_expired(self._proposal)

    def prepare(
        self,
        *,
        action: ProjectAction,
        workspace_display_name: str,
        workspace_id: str | None,
        session_title: str | None,
        session_id: str | None,
        work_order: str | None,
        origin_ref: str,
    ) -> ProjectProposal:
        _validate_prepared(
            action=action,
            workspace_display_name=workspace_display_name,
            workspace_id=workspace_id,
            session_title=session_title,
            session_id=session_id,
            work_order=work_order,
            origin_ref=origin_ref,
        )
        proposal_id = self._id_factory()
        if type(proposal_id) is not str or not proposal_id or len(proposal_id) > 128:
            raise ValueError("invalid confirmation proposal id")
        proposal = ProjectProposal(
            action=action,
            workspace_display_name=workspace_display_name,
            workspace_id=workspace_id,
            session_title=session_title,
            session_id=session_id,
            work_order=work_order,
            origin_ref=origin_ref,
            proposal_id=proposal_id,
            expires_at=self._clock.now() + PROJECT_CONFIRMATION_TTL_SECONDS,
            confirmation_prompt=_confirmation_prompt(
                action,
                workspace_display_name,
                session_title,
                work_order is not None,
            ),
        )
        self._proposal = proposal
        self._reserved = None
        self._commit_authority = None
        self._schedule_expiry(proposal)
        self._publish()
        return proposal

    def observe_expiry(self, observer: Callable[[], None]) -> Callable[[], None]:
        self._expiry_observers.append(observer)

        def unsubscribe() -> None:
            if observer in self._expiry_observers:
                self._expiry_observers.remove(observer)

        return unsubscribe

    def reserve_user_item(self, *, epoch: int, item_id: str) -> bool:
        proposal = self._proposal
        if proposal is None:
            return False
        if self._is_expired(proposal):
            self.expire()
            return False
        if type(epoch) is not int or isinstance(epoch, bool) or epoch < 1:
            return False
        if type(item_id) is not str or not item_id:
            return False
        if self._reserved is not None:
            return self._reserved == (epoch, item_id)
        self._reserved = (epoch, item_id)
        return True

    def accept_decision(
        self,
        *,
        epoch: int,
        item_id: str,
        proposal_id: str,
        confirmed: bool,
    ) -> ConfirmationOutcome:
        proposal = self._proposal
        if proposal is None or not self._is_reserved(epoch, item_id):
            return ConfirmationOutcome(kind="ignored")
        if self._is_expired(proposal):
            self._clear_all()
            self._publish()
            self._publish_expiry()
            return ConfirmationOutcome(
                kind="expired",
                response_text="确认已过期，本次操作已取消。",
            )
        if type(proposal_id) is not str:
            return ConfirmationOutcome(kind="ignored")
        if proposal_id != proposal.proposal_id or type(confirmed) is not bool:
            return ConfirmationOutcome(
                kind="invalid",
                response_text="确认请求无效，操作尚未执行。",
            )
        if confirmed is False:
            self._clear_all()
            self._publish()
            return ConfirmationOutcome(kind="cancelled", response_text="已取消。")
        operation = ConfirmedProjectOperation.from_proposal(proposal)
        self._proposal = None
        self._reserved = None
        self._commit_authority = operation
        self._publish()
        return ConfirmationOutcome(kind="confirmed", operation=operation)

    def release_undecided(self, *, epoch: int, item_id: str) -> bool:
        if self._proposal is None or not self._is_reserved(epoch, item_id):
            return False
        self._reserved = None
        return True

    def claim_confirmed(self, operation: ConfirmedProjectOperation) -> bool:
        if operation is not self._commit_authority:
            return False
        self._commit_authority = None
        return True

    def fail_transcript(self, *, epoch: int, item_id: str) -> ConfirmationOutcome:
        if self._proposal is None or not self._is_reserved(epoch, item_id):
            return ConfirmationOutcome(kind="ignored")
        self._clear_all()
        self._publish()
        return ConfirmationOutcome(
            kind="cancelled",
            response_text="语音识别失败，本次操作已取消。",
        )

    def expire(self) -> bool:
        proposal = self._proposal
        if proposal is None or not self._is_expired(proposal):
            return False
        self._clear_all()
        self._publish()
        self._publish_expiry()
        return True

    def invalidate(self, _reason: str) -> bool:
        changed = self._proposal is not None or self._commit_authority is not None
        if not changed:
            return False
        self._clear_all()
        self._publish()
        return True

    def _is_reserved(self, epoch: object, item_id: object) -> bool:
        if type(epoch) is not int or type(item_id) is not str:
            return False
        return self._reserved == (epoch, item_id)

    def _is_expired(self, proposal: ProjectProposal) -> bool:
        return self._clock.now() >= proposal.expires_at

    def _clear_all(self) -> None:
        self._proposal = None
        self._reserved = None
        self._commit_authority = None
        task, self._expiry_task = self._expiry_task, None
        try:
            current = asyncio.current_task()
        except RuntimeError:
            current = None
        if task is not None and task is not current and not task.done():
            task.cancel()

    def _schedule_expiry(self, proposal: ProjectProposal) -> None:
        old, self._expiry_task = self._expiry_task, None
        if old is not None and not old.done():
            old.cancel()
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._expiry_task = loop.create_task(self._expire_generation(proposal))

    async def _expire_generation(self, proposal: ProjectProposal) -> None:
        try:
            await self._clock.sleep(max(0.0, proposal.expires_at - self._clock.now()))
        except asyncio.CancelledError:
            return
        if self._proposal is not proposal or not self._is_expired(proposal):
            return
        self._clear_all()
        self._publish()
        self._publish_expiry()

    def _publish_expiry(self) -> None:
        for observer in tuple(self._expiry_observers):
            try:
                observer()
            except Exception:
                pass

    def _publish(self) -> None:
        if self._on_change is None:
            return
        try:
            self._on_change(self.view)
        except Exception:
            pass


def _validate_prepared(
    *,
    action: object,
    workspace_display_name: object,
    workspace_id: object,
    session_title: object,
    session_id: object,
    work_order: object,
    origin_ref: object,
) -> None:
    if action not in {"create", "select", "resume"}:
        raise ValueError("invalid project action")
    if type(workspace_display_name) is not str or not workspace_display_name:
        raise ValueError("workspace display name is required")
    for value in (workspace_id, session_title, session_id, work_order):
        if value is not None and (type(value) is not str or not value):
            raise ValueError("invalid project proposal field")
    if type(origin_ref) is not str or not origin_ref:
        raise ValueError("origin ref is required")
    if action == "select" and workspace_id is None:
        raise ValueError("select requires a resolved workspace")
    if action == "resume" and (workspace_id is None or session_id is None or work_order is None):
        raise ValueError("resume requires resolved workspace, Session, and work order")


def _confirmation_prompt(
    action: ProjectAction,
    workspace: str,
    session: str | None,
    has_work_order: bool,
) -> str:
    if action == "resume":
        assert session is not None
        return f"准备切换到{workspace}，并继续 Session“{session}”，请确认或取消。"
    if action == "create" and has_work_order:
        return f"是否创建工作区“{workspace}”并开始任务？请确认或取消。"
    if action == "create":
        return f"准备创建并切换到工作区{workspace}，请确认或取消。"
    return f"准备切换到工作区{workspace}，请确认或取消。"


__all__ = [
    "ConfirmationOutcome",
    "ConfirmedProjectOperation",
    "ProjectConfirmationController",
    "ProjectConfirmationView",
    "ProjectProposal",
]
