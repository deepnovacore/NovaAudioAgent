from __future__ import annotations

import asyncio
from dataclasses import asdict

import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.realtime.project_confirmation import (
    ConfirmedProjectOperation,
    ProjectConfirmationController,
)


class _Ids:
    def __init__(self) -> None:
        self.value = 0

    def __call__(self) -> str:
        self.value += 1
        return f"proposal-{self.value}"


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


def test_matching_structured_true_decision_grants_one_shot_identity_authority() -> None:
    controller = _controller()
    proposal = _prepare_select(controller)

    assert proposal.proposal_id == "proposal-1"
    assert "nonce" not in asdict(proposal)
    assert controller.reserve_user_item(epoch=1, item_id="user-1") is True
    accepted = controller.accept_decision(
        epoch=1,
        item_id="user-1",
        proposal_id=proposal.proposal_id,
        confirmed=True,
    )

    assert accepted.kind == "confirmed"
    assert accepted.operation is not None
    assert accepted.operation.proposal_id == proposal.proposal_id
    assert "nonce" not in asdict(accepted.operation)
    assert controller.pending is False
    assert controller.claim_confirmed(accepted.operation) is True
    assert controller.claim_confirmed(accepted.operation) is False


def test_reconstructed_operation_cannot_claim_identity_authority() -> None:
    controller = _controller()
    proposal = _prepare_select(controller)
    controller.reserve_user_item(epoch=1, item_id="user-1")
    accepted = controller.accept_decision(
        epoch=1,
        item_id="user-1",
        proposal_id=proposal.proposal_id,
        confirmed=True,
    )
    assert accepted.operation is not None
    copied = ConfirmedProjectOperation.from_proposal(accepted.operation)

    assert controller.claim_confirmed(copied) is False
    assert controller.claim_confirmed(accepted.operation) is True


def test_matching_structured_false_decision_cancels_without_authority() -> None:
    controller = _controller()
    proposal = _prepare_select(controller)
    controller.reserve_user_item(epoch=2, item_id="user-2")

    cancelled = controller.accept_decision(
        epoch=2,
        item_id="user-2",
        proposal_id=proposal.proposal_id,
        confirmed=False,
    )

    assert cancelled.kind == "cancelled"
    assert cancelled.operation is None
    assert cancelled.response_text == "已取消。"
    assert controller.pending is False


def test_wrong_proposal_id_and_non_boolean_decisions_are_invalid() -> None:
    controller = _controller()
    proposal = _prepare_select(controller)
    controller.reserve_user_item(epoch=3, item_id="user-3")

    invalid_inputs = [
        ("proposal-other", True),
        (proposal.proposal_id, "true"),
        (proposal.proposal_id, 1),
    ]
    for proposal_id, confirmed in invalid_inputs:
        invalid = controller.accept_decision(
            epoch=3,
            item_id="user-3",
            proposal_id=proposal_id,  # type: ignore[arg-type]
            confirmed=confirmed,  # type: ignore[arg-type]
        )
        assert invalid.kind == "invalid"
        assert invalid.operation is None
        assert controller.pending is True

    accepted = controller.accept_decision(
        epoch=3,
        item_id="user-3",
        proposal_id=proposal.proposal_id,
        confirmed=True,
    )
    assert accepted.operation is not None
    assert controller.claim_confirmed(accepted.operation) is True


class _EqualToEveryProposalId:
    def __eq__(self, other: object) -> bool:
        return True


class _ProposalIdSubclass(str):
    pass


@pytest.mark.parametrize(
    "impostor",
    [7, _EqualToEveryProposalId(), _ProposalIdSubclass("proposal-1")],
    ids=["non-string", "adversarial-equality", "str-subclass"],
)
def test_non_exact_string_proposal_ids_are_ignored_without_moving_state(
    impostor: object,
) -> None:
    controller = _controller()
    proposal = _prepare_select(controller)
    controller.reserve_user_item(epoch=3, item_id="user-3")

    ignored = controller.accept_decision(
        epoch=3,
        item_id="user-3",
        proposal_id=impostor,  # type: ignore[arg-type]
        confirmed=True,
    )

    assert ignored.kind == "ignored"
    assert ignored.operation is None
    assert controller.pending is True
    assert (
        controller.accept_decision(
            epoch=3,
            item_id="user-3",
            proposal_id=proposal.proposal_id,
            confirmed=False,
        ).kind
        == "cancelled"
    )


def test_wrong_epoch_or_item_is_ignored_without_moving_reservation() -> None:
    controller = _controller()
    proposal = _prepare_select(controller)
    controller.reserve_user_item(epoch=4, item_id="reserved")

    for epoch, item_id in [(5, "reserved"), (4, "other"), (True, "reserved"), (4, 7)]:
        ignored = controller.accept_decision(
            epoch=epoch,  # type: ignore[arg-type]
            item_id=item_id,  # type: ignore[arg-type]
            proposal_id=proposal.proposal_id,
            confirmed=True,
        )
        assert ignored.kind == "ignored"
        assert ignored.operation is None

    assert (
        controller.accept_decision(
            epoch=4,
            item_id="reserved",
            proposal_id=proposal.proposal_id,
            confirmed=False,
        ).kind
        == "cancelled"
    )


def test_fail_transcript_rejects_boolean_epoch_without_moving_reservation() -> None:
    controller = _controller()
    _prepare_select(controller)
    controller.reserve_user_item(epoch=1, item_id="reserved")

    ignored = controller.fail_transcript(epoch=True, item_id="reserved")

    assert ignored.kind == "ignored"
    assert controller.pending is True
    assert controller.fail_transcript(epoch=1, item_id="reserved").kind == "cancelled"
    assert controller.pending is False


def test_expired_decision_clears_proposal_and_notifies_without_committing() -> None:
    clock = VirtualClock(start=1.0)
    controller = _controller(clock)
    expiries: list[bool] = []
    proposal = _prepare_select(controller)
    controller.observe_expiry(lambda: expiries.append(True))
    controller.reserve_user_item(epoch=1, item_id="user-1")
    clock.advance_to(91.0)

    expired = controller.accept_decision(
        epoch=1,
        item_id="user-1",
        proposal_id=proposal.proposal_id,
        confirmed=True,
    )

    assert expired.kind == "expired"
    assert expired.operation is None
    assert controller.pending is False
    assert expiries == [True]


def test_release_undecided_releases_only_matching_reservation() -> None:
    controller = _controller()
    proposal = _prepare_select(controller)
    controller.reserve_user_item(epoch=1, item_id="first")

    assert controller.release_undecided(epoch=2, item_id="first") is False
    assert controller.release_undecided(epoch=1, item_id="other") is False
    assert controller.release_undecided(epoch=1, item_id="first") is True
    assert controller.release_undecided(epoch=1, item_id="first") is False
    assert controller.pending is True
    assert controller.reserve_user_item(epoch=1, item_id="second") is True
    assert (
        controller.accept_decision(
            epoch=1,
            item_id="second",
            proposal_id=proposal.proposal_id,
            confirmed=True,
        ).kind
        == "confirmed"
    )


def test_released_proposal_remains_live_only_until_original_expiry() -> None:
    clock = VirtualClock(start=10.0)
    controller = _controller(clock)
    _prepare_select(controller)
    controller.reserve_user_item(epoch=1, item_id="first")
    assert controller.release_undecided(epoch=1, item_id="first") is True

    clock.advance_to(99.9)
    assert controller.pending is True
    clock.advance_to(100.0)
    assert controller.pending is False
    assert controller.reserve_user_item(epoch=1, item_id="late") is False


def test_duplicate_and_replayed_decisions_fail_closed() -> None:
    controller = _controller()
    proposal = _prepare_select(controller)
    controller.reserve_user_item(epoch=1, item_id="user-1")
    accepted = controller.accept_decision(
        epoch=1,
        item_id="user-1",
        proposal_id=proposal.proposal_id,
        confirmed=True,
    )
    assert accepted.operation is not None

    replay = controller.accept_decision(
        epoch=1,
        item_id="user-1",
        proposal_id=proposal.proposal_id,
        confirmed=True,
    )
    assert replay.kind == "ignored"
    assert replay.operation is None
    assert controller.claim_confirmed(accepted.operation) is True
    assert controller.claim_confirmed(accepted.operation) is False


def test_replacement_proposal_invalidates_old_reservation_and_id() -> None:
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

    assert first.proposal_id != second.proposal_id
    assert (
        controller.accept_decision(
            epoch=1,
            item_id="old",
            proposal_id=first.proposal_id,
            confirmed=True,
        ).kind
        == "ignored"
    )


def test_provider_invalidation_clears_proposal_and_unspent_authority() -> None:
    controller = _controller()
    proposal = _prepare_select(controller)
    controller.reserve_user_item(epoch=1, item_id="user-1")
    assert controller.invalidate("provider_replaced") is True
    assert controller.pending is False

    proposal = _prepare_select(controller)
    controller.reserve_user_item(epoch=2, item_id="user-2")
    accepted = controller.accept_decision(
        epoch=2,
        item_id="user-2",
        proposal_id=proposal.proposal_id,
        confirmed=True,
    )
    assert accepted.operation is not None
    assert controller.invalidate("provider_replaced") is True
    assert controller.claim_confirmed(accepted.operation) is False


def test_public_view_and_prompt_contain_no_private_bindings() -> None:
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
    assert (
        proposal.confirmation_prompt
        == "准备切换到天气看板，并继续 Session“登录修复”，请确认或取消。"
    )
    for private in (
        "workspace-secret",
        "session-secret",
        proposal.proposal_id,
        "user:1",
        "继续修复",
    ):
        assert private not in rendered
        assert private not in proposal.confirmation_prompt
    assert changes[-1] == controller.view


@pytest.mark.parametrize("proposal_id", ["", "x" * 129])
def test_invalid_proposal_ids_are_rejected(proposal_id: str) -> None:
    controller = ProjectConfirmationController(
        clock=VirtualClock(),
        id_factory=lambda: proposal_id,
    )
    with pytest.raises(ValueError, match="invalid confirmation proposal id"):
        _prepare_select(controller)
