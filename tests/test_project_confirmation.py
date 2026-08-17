from __future__ import annotations

import asyncio
import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.realtime.project_confirmation import (
    ConfirmedProjectOperation,
    ProjectConfirmationController,
    classify_confirmation,
)


class _Ids:
    def __init__(self) -> None:
        self.value = 0

    def __call__(self) -> str:
        self.value += 1
        return f"nonce-{self.value}"


def _controller(
    clock: VirtualClock | None = None,
    *,
    changes: list[object] | None = None,
) -> ProjectConfirmationController:
    return ProjectConfirmationController(
        clock=clock or VirtualClock(start=10.0),
        id_factory=_Ids(),
        on_change=None if changes is None else changes.append,
    )


def _prepare_select(controller: ProjectConfirmationController):
    return controller.prepare(
        action="select",
        workspace_display_name="天气看板",
        workspace_id="workspace-private",
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="user:1",
    )


async def _checkpoint() -> None:
    return None


@pytest.mark.asyncio
async def test_proposal_expiry_is_clock_scheduled_and_published() -> None:
    clock = VirtualClock(start=10.0)
    changes: list[object] = []
    expired: list[bool] = []
    controller = _controller(clock, changes=changes)
    controller.observe_expiry(lambda: expired.append(True))
    _prepare_select(controller)
    await asyncio.create_task(_checkpoint())

    clock.advance_to(100.0)
    await asyncio.create_task(_checkpoint())

    assert controller.view.pending_confirmation is False
    assert expired == [True]
    assert changes[-1].pending_confirmation is False


@pytest.mark.parametrize(
    "text",
    [
        "确认",
        "确认执行",
        "嗯，确认执行！",
        "好的，可以",
        "那就按这个来呀",
        "同意。",
        "没问题",
        "开始吧",
        "执行吧",
        "做吧",
    ],
)
def test_affirmative_grammar_accepts_only_bounded_whole_utterances(text: str) -> None:
    assert classify_confirmation(text) == "confirm"


@pytest.mark.parametrize(
    "text",
    ["取消", "不确认", "不要", "不行", "先不要", "先别", "算了", "停止"],
)
def test_negative_grammar_cancels(text: str) -> None:
    assert classify_confirmation(text) == "cancel"


@pytest.mark.parametrize(
    "text",
    [
        "确认但不要执行",
        "可以，不过先别",
        "可以顺便删除旧项目",
        "请确认",
        "大概可以",
        "确认一下",
        "嗯",
        "",
    ],
)
def test_mixed_negation_extra_objectives_and_unapproved_wrappers_never_confirm(
    text: str,
) -> None:
    assert classify_confirmation(text) != "confirm"


def test_proposal_has_no_commit_authority_until_matching_asr_confirms() -> None:
    controller = _controller()
    proposal = _prepare_select(controller)

    assert proposal.nonce == "nonce-1"
    assert controller.view.pending_confirmation is True
    assert controller.claim_confirmed(ConfirmedProjectOperation.from_proposal(proposal)) is False
    assert controller.reserve_user_item(epoch=3, item_id="u1") is True
    assert controller.accept_transcript(epoch=3, item_id="other", text="确认").kind == "ignored"

    outcome = controller.accept_transcript(epoch=3, item_id="u1", text="确认")

    assert outcome.kind == "confirmed"
    assert outcome.operation is not None
    assert controller.view.pending_confirmation is False
    assert controller.claim_confirmed(outcome.operation) is True
    assert controller.claim_confirmed(outcome.operation) is False


def test_reconstructed_operation_cannot_claim_the_single_use_authority() -> None:
    controller = _controller()
    _prepare_select(controller)
    controller.reserve_user_item(epoch=1, item_id="u")
    outcome = controller.accept_transcript(epoch=1, item_id="u", text="可以")
    assert outcome.operation is not None
    copied = ConfirmedProjectOperation.from_proposal(outcome.operation)

    assert controller.claim_confirmed(copied) is False
    assert controller.claim_confirmed(outcome.operation) is True


def test_first_short_unknown_retries_and_second_unknown_cancels() -> None:
    controller = _controller()
    _prepare_select(controller)
    controller.reserve_user_item(epoch=1, item_id="u1")

    retry = controller.accept_transcript(epoch=1, item_id="u1", text="行吗")
    assert retry.kind == "retry"
    assert controller.view.pending_confirmation is True
    assert controller.reserve_user_item(epoch=1, item_id="u2") is True

    cancelled = controller.accept_transcript(epoch=1, item_id="u2", text="你看着办")
    assert cancelled.kind == "cancelled"
    assert controller.view.pending_confirmation is False


def test_long_unrecognized_reply_cancels_without_retry() -> None:
    controller = _controller()
    _prepare_select(controller)
    controller.reserve_user_item(epoch=1, item_id="u")

    outcome = controller.accept_transcript(
        epoch=1,
        item_id="u",
        text="我现在想换一个完全不同的新任务请先不要处理刚才那个提议",
    )

    assert outcome.kind == "cancelled"
    assert controller.view.pending_confirmation is False


def test_expired_proposal_never_confirms() -> None:
    clock = VirtualClock(start=1.0)
    controller = _controller(clock)
    _prepare_select(controller)
    controller.reserve_user_item(epoch=1, item_id="u")
    clock.advance_to(91.1)

    outcome = controller.accept_transcript(epoch=1, item_id="u", text="确认")

    assert outcome.kind == "expired"
    assert controller.view.pending_confirmation is False


def test_expired_confirmation_view_suppresses_stale_public_labels_immediately() -> None:
    clock = VirtualClock(start=1.0)
    controller = _controller(clock)
    _prepare_select(controller)

    clock.advance_to(91.0)
    view = controller.view

    assert view.pending_confirmation is False
    assert view.workspace_display_name is None
    assert view.session_title is None


def test_newer_proposal_replaces_old_nonce_and_reservation() -> None:
    controller = _controller()
    first = _prepare_select(controller)
    controller.reserve_user_item(epoch=1, item_id="old")
    second = controller.prepare(
        action="create",
        workspace_display_name="新项目",
        workspace_id=None,
        session_title=None,
        session_id=None,
        work_order="创建 README",
        origin_ref="user:2",
    )

    assert first.nonce != second.nonce
    assert controller.accept_transcript(epoch=1, item_id="old", text="确认").kind == "ignored"
    assert controller.reserve_user_item(epoch=2, item_id="new") is True


def test_asr_failure_and_provider_replacement_clear_every_private_authority() -> None:
    controller = _controller()
    _prepare_select(controller)
    controller.reserve_user_item(epoch=1, item_id="u")

    assert controller.fail_transcript(epoch=1, item_id="u").kind == "cancelled"
    assert controller.view.pending_confirmation is False
    _prepare_select(controller)
    assert controller.invalidate("provider_replaced") is True
    assert controller.view.pending_confirmation is False


def test_public_view_and_prompt_contain_names_but_no_private_bindings() -> None:
    changes: list[object] = []
    controller = _controller(changes=changes)
    proposal = controller.prepare(
        action="resume",
        workspace_display_name="天气看板",
        workspace_id="workspace-secret",
        session_title="登录修复",
        session_id="session-secret",
        work_order="继续修复",
        origin_ref="user:1",
    )

    rendered = repr(controller.view)
    assert controller.view.workspace_display_name == "天气看板"
    assert controller.view.session_title == "登录修复"
    assert proposal.confirmation_prompt == (
        "准备切换到天气看板，并继续 Session“登录修复”，请确认或取消。"
    )
    for private in ("workspace-secret", "session-secret", "nonce-1", "user:1", "继续修复"):
        assert private not in rendered
        assert private not in proposal.confirmation_prompt
    assert changes[-1] == controller.view
