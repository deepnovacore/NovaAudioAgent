"""Deterministic host confirmation for Codex project boundary changes."""

from __future__ import annotations

import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, Protocol

from nova_audio_agent.clock import Clock

ProjectAction = Literal["create", "select", "resume"]
ConfirmationClass = Literal["confirm", "cancel", "unknown"]
ConfirmationKind = Literal["confirmed", "cancelled", "retry", "expired", "ignored"]

_POSITIVE = frozenset(
    {
        "确认",
        "确认执行",
        "可以",
        "可以执行",
        "同意",
        "没问题",
        "就这么做",
        "按这个来",
        "开始吧",
        "执行吧",
        "做吧",
    }
)
_NEGATIVE = frozenset({"取消", "不确认", "不要", "不行", "先不要", "先别", "算了", "停止"})
_LEADING = tuple(sorted(("嗯", "嗯嗯", "好", "好的", "那", "那就"), key=len, reverse=True))
_TRAILING = tuple(sorted(("啊", "呀", "哦", "啦"), key=len, reverse=True))
_MAX_RETRY_CHARS = 24
_EXPIRY_SECONDS = 90.0


@dataclass(frozen=True, slots=True)
class ProjectProposal:
    action: ProjectAction
    workspace_display_name: str
    workspace_id: str | None
    session_title: str | None
    session_id: str | None
    work_order: str | None
    origin_ref: str
    nonce: str
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
    nonce: str


@dataclass(frozen=True, slots=True)
class ConfirmedProjectOperation:
    action: ProjectAction
    workspace_display_name: str
    workspace_id: str | None
    session_title: str | None
    session_id: str | None
    work_order: str | None
    origin_ref: str
    nonce: str

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
            nonce=proposal.nonce,
        )


@dataclass(frozen=True, slots=True)
class ProjectConfirmationView:
    pending_confirmation: bool
    workspace_display_name: str | None = None
    session_title: str | None = None


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
        self._retry_count = 0
        self._commit_authority: ConfirmedProjectOperation | None = None

    @property
    def view(self) -> ProjectConfirmationView:
        proposal = self._proposal
        return ProjectConfirmationView(
            pending_confirmation=proposal is not None,
            workspace_display_name=(None if proposal is None else proposal.workspace_display_name),
            session_title=None if proposal is None else proposal.session_title,
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
        nonce = self._id_factory()
        if type(nonce) is not str or not nonce or len(nonce) > 128:
            raise ValueError("invalid confirmation nonce")
        proposal = ProjectProposal(
            action=action,
            workspace_display_name=workspace_display_name,
            workspace_id=workspace_id,
            session_title=session_title,
            session_id=session_id,
            work_order=work_order,
            origin_ref=origin_ref,
            nonce=nonce,
            expires_at=self._clock.now() + _EXPIRY_SECONDS,
            confirmation_prompt=_confirmation_prompt(
                action,
                workspace_display_name,
                session_title,
                work_order is not None,
            ),
        )
        self._proposal = proposal
        self._reserved = None
        self._retry_count = 0
        self._commit_authority = None
        self._publish()
        return proposal

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

    def accept_transcript(self, *, epoch: int, item_id: str, text: str) -> ConfirmationOutcome:
        proposal = self._proposal
        if proposal is None or self._reserved != (epoch, item_id):
            return ConfirmationOutcome(kind="ignored")
        if self._is_expired(proposal):
            self._clear_all()
            self._publish()
            return ConfirmationOutcome(
                kind="expired",
                response_text="确认已过期，本次操作已取消。",
            )
        classification = classify_confirmation(text)
        if classification == "confirm":
            operation = ConfirmedProjectOperation.from_proposal(proposal)
            self._proposal = None
            self._reserved = None
            self._retry_count = 0
            self._commit_authority = operation
            self._publish()
            return ConfirmationOutcome(kind="confirmed", operation=operation)
        if classification == "cancel":
            self._clear_all()
            self._publish()
            return ConfirmationOutcome(kind="cancelled", response_text="已取消。")
        normalized = _normalized_utterance(text)
        if self._retry_count == 0 and len(normalized) <= _MAX_RETRY_CHARS:
            self._retry_count = 1
            self._reserved = None
            return ConfirmationOutcome(
                kind="retry",
                response_text="没有听清，请说“确认”“可以”，或者说“取消”。",
            )
        self._clear_all()
        self._publish()
        return ConfirmationOutcome(kind="cancelled", response_text="未收到明确确认，已取消。")

    def claim_confirmed(self, operation: ConfirmedProjectOperation) -> bool:
        if operation is not self._commit_authority:
            return False
        self._commit_authority = None
        return True

    def fail_transcript(self, *, epoch: int, item_id: str) -> ConfirmationOutcome:
        if self._proposal is None or self._reserved != (epoch, item_id):
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
        return True

    def invalidate(self, _reason: str) -> bool:
        changed = self._proposal is not None or self._commit_authority is not None
        if not changed:
            return False
        self._clear_all()
        self._publish()
        return True

    def _is_expired(self, proposal: ProjectProposal) -> bool:
        return self._clock.now() >= proposal.expires_at

    def _clear_all(self) -> None:
        self._proposal = None
        self._reserved = None
        self._retry_count = 0
        self._commit_authority = None

    def _publish(self) -> None:
        if self._on_change is None:
            return
        try:
            self._on_change(self.view)
        except Exception:
            pass


def classify_confirmation(text: object) -> ConfirmationClass:
    normalized = _normalized_utterance(text)
    if not normalized:
        return "unknown"
    if any(negative in normalized for negative in _NEGATIVE):
        return "cancel"
    if normalized in _POSITIVE:
        return "confirm"
    core = normalized
    for token in _LEADING:
        if core.startswith(token):
            core = core[len(token) :]
            break
    for token in _TRAILING:
        if core.endswith(token):
            core = core[: -len(token)]
            break
    return "confirm" if core in _POSITIVE else "unknown"


def _normalized_utterance(text: object) -> str:
    if type(text) is not str:
        return ""
    return "".join(
        character
        for character in unicodedata.normalize("NFKC", text)
        if not character.isspace()
        and not unicodedata.category(character).startswith("P")
        and not unicodedata.category(character).startswith("C")
    )


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
        return f"准备创建工作区{workspace}，并在其中开始任务，请确认或取消。"
    if action == "create":
        return f"准备创建并切换到工作区{workspace}，请确认或取消。"
    return f"准备切换到工作区{workspace}，请确认或取消。"


__all__ = [
    "ConfirmationOutcome",
    "ConfirmedProjectOperation",
    "ProjectConfirmationController",
    "ProjectConfirmationView",
    "ProjectProposal",
    "classify_confirmation",
]
