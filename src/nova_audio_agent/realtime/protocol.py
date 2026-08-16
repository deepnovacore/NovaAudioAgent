"""Provider-neutral realtime session commands and normalized events."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Literal, Protocol, TypeAlias

from nova_audio_agent.realtime.history import MAX_PACKED_RECOVERY_CONTENT

MAX_REALTIME_TEXT = 4000
HostItemKind = Literal["progress", "final", "recovery", "dialogue_context", "tool_output"]
HostResponseKind = Literal["host_fact", "tool_result", "delegation_acknowledgement"]
ResponseStatus = Literal["completed", "cancelled", "failed"]
ResponseCancelRejectReason = Literal["no_active_response"]


class ItemDeliveryUncertainError(RuntimeError):
    """The provider may have accepted an item whose confirmation never arrived."""

    def __init__(
        self,
        *,
        session_epoch: int,
        host_item_id: str,
        provider_item_id: str,
        item_kind: HostItemKind,
    ) -> None:
        _require_epoch(session_epoch)
        _require_id(host_item_id, "host_item_id")
        _require_id(provider_item_id, "provider_item_id")
        if item_kind not in {
            "progress",
            "final",
            "recovery",
            "dialogue_context",
            "tool_output",
        }:
            raise ValueError("unknown host item kind")
        super().__init__("host item confirmation timed out; delivery is uncertain")
        self.session_epoch = session_epoch
        self.host_item_id = host_item_id
        self.provider_item_id = provider_item_id
        self.item_kind = item_kind


def _require_id(value: str, field: str) -> None:
    if type(value) is not str or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")


def _require_epoch(value: int) -> None:
    if type(value) is not int or value < 1:
        raise ValueError("session_epoch must be a positive integer")


def _require_text(value: str, field: str, *, allow_empty: bool = False) -> None:
    if type(value) is not str or (not allow_empty and not value.strip()):
        raise ValueError(f"{field} must be a non-empty string")
    if len(value) > MAX_REALTIME_TEXT:
        raise ValueError(f"{field} exceeds {MAX_REALTIME_TEXT} characters")


@dataclass(frozen=True, slots=True)
class HostContextItem:
    kind: HostItemKind
    host_item_id: str
    event_id: str
    content: str
    call_id: str | None = None

    def __post_init__(self) -> None:
        if self.kind not in {
            "progress",
            "final",
            "recovery",
            "dialogue_context",
            "tool_output",
        }:
            raise ValueError("unknown host item kind")
        _require_id(self.host_item_id, "host_item_id")
        _require_id(self.event_id, "event_id")
        _require_text(self.content, "content")
        if self.kind == "dialogue_context" and len(self.content) > MAX_PACKED_RECOVERY_CONTENT:
            raise ValueError(f"dialogue context exceeds {MAX_PACKED_RECOVERY_CONTENT} characters")
        if self.kind == "tool_output":
            if self.call_id is None:
                raise ValueError("tool output call_id is required")
            _require_id(self.call_id, "call_id")
        elif self.call_id is not None:
            raise ValueError("call_id is only valid for tool output")

    @classmethod
    def progress(cls, *, host_item_id: str, event_id: str, content: str) -> HostContextItem:
        return cls(
            kind="progress",
            host_item_id=host_item_id,
            event_id=event_id,
            content=content,
        )

    @classmethod
    def final(cls, *, host_item_id: str, event_id: str, content: str) -> HostContextItem:
        return cls(kind="final", host_item_id=host_item_id, event_id=event_id, content=content)

    @classmethod
    def recovery(cls, *, host_item_id: str, event_id: str, content: str) -> HostContextItem:
        return cls(kind="recovery", host_item_id=host_item_id, event_id=event_id, content=content)

    @classmethod
    def dialogue_context(cls, *, host_item_id: str, event_id: str, content: str) -> HostContextItem:
        return cls(
            kind="dialogue_context",
            host_item_id=host_item_id,
            event_id=event_id,
            content=content,
        )

    @classmethod
    def tool_output(
        cls,
        *,
        host_item_id: str,
        event_id: str,
        call_id: str,
        content: str,
    ) -> HostContextItem:
        return cls(
            kind="tool_output",
            host_item_id=host_item_id,
            event_id=event_id,
            content=content,
            call_id=call_id,
        )


@dataclass(frozen=True, slots=True)
class HostResponseIntent:
    kind: HostResponseKind
    item: HostContextItem
    task_summary: str | None = None
    # #55: host-asserted fact that the origin response already voiced this
    # acceptance; the provider renders a hard silence directive instead of the
    # self-judged soft clause.
    origin_spoken: bool = False

    def __post_init__(self) -> None:
        if self.kind not in {"host_fact", "tool_result", "delegation_acknowledgement"}:
            raise ValueError("unknown host response kind")
        if type(self.origin_spoken) is not bool:
            raise ValueError("origin_spoken must be a bool")
        if self.kind == "delegation_acknowledgement":
            if self.item.kind != "tool_output":
                raise ValueError("delegation acknowledgement requires tool output")
            if self.task_summary is None:
                raise ValueError("task_summary is required")
            _require_text(self.task_summary, "task_summary")
        else:
            if self.task_summary is not None:
                raise ValueError("task_summary is only valid for delegation acknowledgement")
            if self.origin_spoken:
                raise ValueError("origin_spoken is only valid for delegation acknowledgement")

    @classmethod
    def host_fact(cls, item: HostContextItem) -> HostResponseIntent:
        if item.kind == "tool_output":
            raise ValueError("host fact cannot be tool output")
        if item.kind == "dialogue_context":
            raise ValueError("dialogue context cannot create a response")
        return cls(kind="host_fact", item=item)

    @classmethod
    def tool_result(cls, item: HostContextItem) -> HostResponseIntent:
        if item.kind != "tool_output":
            raise ValueError("tool result requires tool output")
        return cls(kind="tool_result", item=item)

    @classmethod
    def delegation_acknowledgement(
        cls,
        *,
        item: HostContextItem,
        task_summary: str,
        origin_spoken: bool = False,
    ) -> HostResponseIntent:
        return cls(
            kind="delegation_acknowledgement",
            item=item,
            task_summary=task_summary,
            origin_spoken=origin_spoken,
        )


@dataclass(frozen=True, slots=True)
class SessionIdentity:
    epoch: int
    provider_session_id: str

    def __post_init__(self) -> None:
        _require_epoch(self.epoch)
        _require_id(self.provider_session_id, "provider_session_id")


@dataclass(frozen=True, slots=True)
class ItemIdentity:
    session_epoch: int
    host_item_id: str
    provider_item_id: str

    def __post_init__(self) -> None:
        _require_epoch(self.session_epoch)
        _require_id(self.host_item_id, "host_item_id")
        _require_id(self.provider_item_id, "provider_item_id")


@dataclass(frozen=True, slots=True)
class _SessionEvent:
    session_epoch: int

    def __post_init__(self) -> None:
        _require_epoch(self.session_epoch)


@dataclass(frozen=True, slots=True)
class UserSpeechStarted(_SessionEvent):
    speech_id: str
    provider_item_id: str | None = None

    def __post_init__(self) -> None:
        super(UserSpeechStarted, self).__post_init__()
        _require_id(self.speech_id, "speech_id")
        if self.provider_item_id is not None:
            _require_id(self.provider_item_id, "provider_item_id")


@dataclass(frozen=True, slots=True)
class UserSpeechEnded(_SessionEvent):
    speech_id: str
    provider_item_id: str | None = None

    def __post_init__(self) -> None:
        super(UserSpeechEnded, self).__post_init__()
        _require_id(self.speech_id, "speech_id")
        if self.provider_item_id is not None:
            _require_id(self.provider_item_id, "provider_item_id")


@dataclass(frozen=True, slots=True)
class _ItemTextEvent(_SessionEvent):
    item_id: str
    text: str

    def __post_init__(self) -> None:
        super(_ItemTextEvent, self).__post_init__()
        _require_id(self.item_id, "item_id")
        _require_text(self.text, "text", allow_empty=True)


@dataclass(frozen=True, slots=True)
class UserTranscriptDelta(_ItemTextEvent):
    pass


@dataclass(frozen=True, slots=True)
class UserTranscriptFailed(_SessionEvent):
    item_id: str

    def __post_init__(self) -> None:
        super(UserTranscriptFailed, self).__post_init__()
        _require_id(self.item_id, "item_id")


@dataclass(frozen=True, slots=True)
class UserTranscriptFinal(_ItemTextEvent):
    pass


@dataclass(frozen=True, slots=True)
class ResponseStarted(_SessionEvent):
    response_id: str

    def __post_init__(self) -> None:
        super(ResponseStarted, self).__post_init__()
        _require_id(self.response_id, "response_id")


@dataclass(frozen=True, slots=True)
class ResponseAudioDelta:
    session_epoch: int
    response_id: str
    pcm: bytes

    def __post_init__(self) -> None:
        _require_epoch(self.session_epoch)
        _require_id(self.response_id, "response_id")
        if type(self.pcm) is not bytes or not self.pcm or len(self.pcm) % 2:
            raise ValueError("pcm must be non-empty aligned PCM16 bytes")


@dataclass(frozen=True, slots=True)
class _ResponseTextEvent(_SessionEvent):
    response_id: str
    text: str

    def __post_init__(self) -> None:
        super(_ResponseTextEvent, self).__post_init__()
        _require_id(self.response_id, "response_id")
        _require_text(self.text, "text", allow_empty=True)


@dataclass(frozen=True, slots=True)
class ResponseTranscriptDelta(_ResponseTextEvent):
    pass


@dataclass(frozen=True, slots=True)
class ResponseTranscriptFinal(_ResponseTextEvent):
    pass


@dataclass(frozen=True, slots=True)
class ToolCallReady(_SessionEvent):
    call_id: str
    item_id: str
    name: str
    arguments: dict[str, Any]
    response_id: str | None = None

    def __post_init__(self) -> None:
        super(ToolCallReady, self).__post_init__()
        _require_id(self.call_id, "call_id")
        _require_id(self.item_id, "item_id")
        _require_id(self.name, "name")
        if type(self.arguments) is not dict:
            raise ValueError("arguments must be an object")
        if self.response_id is not None:
            _require_id(self.response_id, "response_id")


@dataclass(frozen=True, slots=True)
class ItemConfirmed(_SessionEvent):
    host_item_id: str
    provider_item_id: str

    def __post_init__(self) -> None:
        super(ItemConfirmed, self).__post_init__()
        _require_id(self.host_item_id, "host_item_id")
        _require_id(self.provider_item_id, "provider_item_id")


@dataclass(frozen=True, slots=True)
class ResponseTerminal(_SessionEvent):
    response_id: str
    status: ResponseStatus
    reason: str

    def __post_init__(self) -> None:
        super(ResponseTerminal, self).__post_init__()
        _require_id(self.response_id, "response_id")
        if self.status not in {"completed", "cancelled", "failed"}:
            raise ValueError("unknown response status")
        _require_text(self.reason, "reason")


@dataclass(frozen=True, slots=True)
class ResponseCancelRejected(_SessionEvent):
    response_id: str
    cancel_request_id: str
    reason: ResponseCancelRejectReason

    def __post_init__(self) -> None:
        super(ResponseCancelRejected, self).__post_init__()
        _require_id(self.response_id, "response_id")
        _require_id(self.cancel_request_id, "cancel_request_id")
        if self.reason != "no_active_response":
            raise ValueError("unknown response cancel rejection reason")


@dataclass(frozen=True, slots=True)
class ProviderErrorEvent(_SessionEvent):
    code: str
    recoverable: bool = False

    def __post_init__(self) -> None:
        super(ProviderErrorEvent, self).__post_init__()
        _require_id(self.code, "code")
        if type(self.recoverable) is not bool:
            raise ValueError("recoverable must be bool")


RealtimeFrontBrainEvent: TypeAlias = (
    UserSpeechStarted
    | UserSpeechEnded
    | UserTranscriptDelta
    | UserTranscriptFailed
    | UserTranscriptFinal
    | ResponseStarted
    | ResponseAudioDelta
    | ResponseTranscriptDelta
    | ResponseTranscriptFinal
    | ToolCallReady
    | ItemConfirmed
    | ResponseTerminal
    | ResponseCancelRejected
    | ProviderErrorEvent
)


class RealtimeFrontBrain(Protocol):
    async def connect(self, *, tools: tuple[dict[str, Any], ...]) -> SessionIdentity: ...

    async def send_audio(self, pcm: bytes) -> None: ...

    async def inject_host_item(
        self,
        item: HostContextItem,
        *,
        confirmation_timeout: float | None = None,
        as_user_activation: bool = False,
    ) -> ItemIdentity: ...

    async def create_response(self, intent: HostResponseIntent) -> None: ...

    async def cancel_response(self, response_id: str) -> None: ...

    def events(self) -> AsyncIterator[RealtimeFrontBrainEvent]: ...

    async def close(self) -> None: ...
