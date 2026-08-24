from dataclasses import FrozenInstanceError, replace

import pytest

import nova_audio_agent.realtime as realtime_contract
from nova_audio_agent.realtime import protocol
from nova_audio_agent.realtime import HostResponseIntent as ExportedHostResponseIntent
from nova_audio_agent.realtime.protocol import (
    HostContextItem,
    ItemDeliveryUncertainError,
    ItemConfirmed,
    ItemIdentity,
    ProviderErrorEvent,
    ResponseAudioDelta,
    ResponseCancelRejected,
    ResponseStarted,
    ResponseTerminal,
    ResponseTranscriptDelta,
    ResponseTranscriptFinal,
    SessionIdentity,
    ToolCallReady,
    UserSpeechEnded,
    UserSpeechStarted,
    UserTranscriptDelta,
    UserTranscriptFailed,
    UserTranscriptFinal,
)


@pytest.mark.parametrize(
    "kwargs",
    [
        {
            "session_epoch": 0,
            "host_item_id": "host-item",
            "provider_item_id": "provider-item",
            "item_kind": "progress",
        },
        {
            "session_epoch": 1,
            "host_item_id": "host-item",
            "provider_item_id": "provider-item",
            "item_kind": "unknown",
        },
    ],
)
def test_uncertain_delivery_error_rejects_invalid_identity(kwargs: dict[str, object]) -> None:
    with pytest.raises(ValueError):
        ItemDeliveryUncertainError(**kwargs)  # type: ignore[arg-type]


def test_uncertain_delivery_error_is_exported_by_realtime_contract() -> None:
    assert getattr(realtime_contract, "ItemDeliveryUncertainError", None) is (
        ItemDeliveryUncertainError
    )


def test_delegation_acknowledgement_is_a_bounded_typed_response_intent() -> None:
    """Reducing acknowledgement to an opaque create-response call loses task identity."""
    intent_type = getattr(protocol, "HostResponseIntent", None)
    assert intent_type is not None
    assert ExportedHostResponseIntent is intent_type
    item = HostContextItem.tool_output(
        host_item_id="host-tool",
        event_id="event-tool",
        call_id="call-provider",
        content='{"state":"accepted"}',
    )

    intent = intent_type.delegation_acknowledgement(
        item=item,
        task_summary="运行完整 Python 测试",
    )

    assert intent.kind == "delegation_acknowledgement"
    assert intent.item is item
    assert intent.task_summary == "运行完整 Python 测试"
    with pytest.raises(ValueError, match="task_summary"):
        intent_type.delegation_acknowledgement(item=item, task_summary="x" * 4001)


def test_origin_spoken_is_only_valid_on_delegation_acknowledgement() -> None:
    """#55: the origin-already-spoke flag rides the ack intent; other kinds
    must reject it so a stray flag cannot silence an unrelated response."""
    item = HostContextItem.tool_output(
        host_item_id="host-tool",
        event_id="event-tool",
        call_id="call-provider",
        content='{"state":"accepted"}',
    )

    spoken = ExportedHostResponseIntent.delegation_acknowledgement(
        item=item,
        task_summary="监控水杯",
        origin_spoken=True,
    )
    assert spoken.origin_spoken is True
    silent = ExportedHostResponseIntent.delegation_acknowledgement(
        item=item,
        task_summary="监控水杯",
    )
    assert silent.origin_spoken is False

    with pytest.raises(ValueError, match="origin_spoken"):
        ExportedHostResponseIntent(kind="tool_result", item=item, origin_spoken=True)
    with pytest.raises(ValueError, match="origin_spoken"):
        ExportedHostResponseIntent.delegation_acknowledgement(
            item=item,
            task_summary="监控水杯",
            origin_spoken="true",  # type: ignore[arg-type]
        )


def test_response_audio_rejects_empty_response_identity() -> None:
    """Removing response identity validation would admit uncorrelatable PCM."""
    with pytest.raises(ValueError, match="response_id"):
        ResponseAudioDelta(
            session_epoch=2,
            response_id="",
            pcm=b"\x00\x00",
        )


def test_host_item_rejects_oversize_provider_content() -> None:
    """Removing the provider-content bound would allow an unbounded host injection."""
    with pytest.raises(ValueError, match="content"):
        HostContextItem.progress(
            host_item_id="h-1",
            event_id="e-1",
            content="x" * 4001,
        )


def test_tool_output_host_item_requires_provider_call_identity() -> None:
    """A tool result without its provider call ID cannot close the correct tool call."""
    with pytest.raises(ValueError, match="call_id"):
        HostContextItem(
            kind="tool_output",
            host_item_id="host-1",
            event_id="event-1",
            content='{"state":"accepted"}',
        )

    item = HostContextItem.tool_output(
        host_item_id="host-1",
        event_id="event-1",
        call_id="call-provider-1",
        content='{"state":"accepted"}',
    )
    assert item.call_id == "call-provider-1"


def test_dialogue_context_is_a_distinct_data_only_host_item() -> None:
    item = HostContextItem.dialogue_context(
        host_item_id="history-1",
        event_id="history-event-1",
        content='{"turns":[{"role":"user","text":"之前的问题"}]}',
    )

    assert item.kind == "dialogue_context"
    assert item.call_id is None
    with pytest.raises(ValueError, match="call_id"):
        HostContextItem(
            kind="dialogue_context",
            host_item_id="history-1",
            event_id="history-event-1",
            content="{}",
            call_id="tool-call",
        )

    with pytest.raises(ValueError, match="dialogue context exceeds"):
        HostContextItem.dialogue_context(
            host_item_id="history-2",
            event_id="history-event-2",
            content="x" * 4000,
        )


def test_identity_types_reject_nonpositive_session_epochs() -> None:
    """Removing epoch validation would let old-session evidence cross reconnect."""
    with pytest.raises(ValueError, match="epoch"):
        SessionIdentity(epoch=0, provider_session_id="provider-session")
    with pytest.raises(ValueError, match="epoch"):
        ItemIdentity(
            session_epoch=0,
            host_item_id="host-item",
            provider_item_id="provider-item",
        )


@pytest.mark.parametrize(
    "event",
    [
        UserSpeechStarted(session_epoch=1, speech_id="speech-1"),
        UserSpeechEnded(session_epoch=1, speech_id="speech-1"),
        UserTranscriptDelta(session_epoch=1, item_id="item-1", text="partial"),
        UserTranscriptFailed(session_epoch=1, item_id="item-1"),
        UserTranscriptFinal(session_epoch=1, item_id="item-1", text="final"),
        ResponseStarted(session_epoch=1, response_id="response-1"),
        ResponseTranscriptDelta(session_epoch=1, response_id="response-1", text="partial"),
        ResponseTranscriptFinal(session_epoch=1, response_id="response-1", text="final"),
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-2",
            name="codex__run",
            arguments={"work_order": "build it"},
            response_id="response-1",
        ),
        ItemConfirmed(
            session_epoch=1,
            host_item_id="host-1",
            provider_item_id="provider-1",
        ),
        ResponseTerminal(
            session_epoch=1,
            response_id="response-1",
            status="cancelled",
            reason="client_cancelled",
        ),
        ResponseCancelRejected(
            session_epoch=1,
            response_id="response-1",
            cancel_request_id="cancel-request-1",
            reason="no_active_response",
        ),
        ProviderErrorEvent(session_epoch=1, code="inactivity", recoverable=True),
    ],
)
def test_normalized_events_are_immutable(event: object) -> None:
    """Making normalized events mutable would invalidate correlation after admission."""
    with pytest.raises(FrozenInstanceError):
        setattr(event, "session_epoch", 2)


def test_user_transcript_failure_has_no_transcript_text() -> None:
    """A provider ASR failure must terminate correlation without fabricating user text."""
    failed = UserTranscriptFailed(session_epoch=1, item_id="user-item")

    assert failed.item_id == "user-item"
    assert not hasattr(failed, "text")


def test_tool_call_requires_object_arguments() -> None:
    """Accepting non-object arguments would bypass manifest parameter validation."""
    with pytest.raises(ValueError, match="arguments"):
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments=[],  # type: ignore[arg-type]
        )


def test_confirmation_tool_arguments_preserve_exact_boolean_type_for_host_validation() -> None:
    false_decision = ToolCallReady(
        session_epoch=1,
        call_id="confirm-false",
        item_id="function-false",
        name="codex__confirm_project_action",
        arguments={"proposal_id": "proposal-1", "confirmed": False},
        response_id="response-1",
    )
    string_impostor = replace(
        false_decision,
        call_id="confirm-string",
        arguments={"proposal_id": "proposal-1", "confirmed": "true"},
    )

    assert false_decision.arguments["confirmed"] is False
    assert type(string_impostor.arguments["confirmed"]) is str


def test_response_terminal_rejects_unknown_status() -> None:
    """Unknown terminal semantics must fail closed instead of releasing a generation."""
    with pytest.raises(ValueError, match="status"):
        ResponseTerminal(
            session_epoch=1,
            response_id="response-1",
            status="unknown",  # type: ignore[arg-type]
            reason="provider_drift",
        )


def test_cancel_rejection_preserves_only_local_correlation_and_bounded_reason() -> None:
    """Raw provider prose must not cross the provider-neutral cancellation boundary."""
    event = ResponseCancelRejected(
        session_epoch=3,
        response_id="response-automatic",
        cancel_request_id="event-cancel",
        reason="no_active_response",
    )

    assert event == ResponseCancelRejected(
        session_epoch=3,
        response_id="response-automatic",
        cancel_request_id="event-cancel",
        reason="no_active_response",
    )
    assert not hasattr(event, "message")


@pytest.mark.parametrize(
    "kwargs",
    [
        {
            "session_epoch": 0,
            "response_id": "response-automatic",
            "cancel_request_id": "event-cancel",
            "reason": "no_active_response",
        },
        {
            "session_epoch": 1,
            "response_id": "",
            "cancel_request_id": "event-cancel",
            "reason": "no_active_response",
        },
        {
            "session_epoch": 1,
            "response_id": "response-automatic",
            "cancel_request_id": "",
            "reason": "no_active_response",
        },
        {
            "session_epoch": 1,
            "response_id": "response-automatic",
            "cancel_request_id": "event-cancel",
            "reason": "No active response found to cancel.",
        },
    ],
)
def test_cancel_rejection_rejects_invalid_or_provider_specific_fields(
    kwargs: dict[str, object],
) -> None:
    with pytest.raises(ValueError):
        ResponseCancelRejected(**kwargs)  # type: ignore[arg-type]
