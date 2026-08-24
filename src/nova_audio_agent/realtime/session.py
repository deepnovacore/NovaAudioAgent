"""Nova Audio Agent-owned realtime correlation, Floor, and recovery policy."""

from __future__ import annotations

import asyncio
from collections import OrderedDict, deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal

from nova_audio_agent.clock import Clock, RealClock
from nova_audio_agent.floor import Floor
from nova_audio_agent.memory.policy import USER_PRIORITY
from nova_audio_agent.ports import PROGRESS_SUMMARY_LIMIT
from nova_audio_agent.realtime.history import RecoveryTurn, pack_recovery_turns
from nova_audio_agent.realtime.playback import (
    PlaybackCompletion,
    PlaybackGeneration,
    PlaybackRegistry,
)
from nova_audio_agent.realtime.protocol import (
    MAX_REALTIME_TEXT,
    HostContextItem,
    HostResponseIntent,
    ItemDeliveryUncertainError,
    RealtimeFrontBrain,
    RealtimeFrontBrainEvent,
    ResponseAudioDelta,
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

DelegateState = Literal["running", "completed", "failed", "unknown"]
MAX_PREMAP_AUDIO_BYTES = 64 * 1024
MAX_TRACKED_HOST_EVENTS = 500
MAX_PENDING_HOST_EVENTS = 532
MAX_TRACKED_PROVIDER_TURNS = 500
MAX_CONTINUATION_TASK_SUMMARY = 240
ProviderTurnPhase = Literal[
    "active",
    "cancel_requested",
    "completed",
    "cancelled",
    "failed",
]
ContinuationRequestResult = Literal["requested", "retryable", "rejected"]


class RealtimeDeliveryError(RuntimeError):
    """A provider delivery operation may be resumed by a later event or wake."""


@dataclass(frozen=True, slots=True)
class HostResponseDelivery:
    accepted: bool
    injection_epoch: int | None = None


@dataclass(frozen=True, slots=True)
class FenceInterruption:
    session_epoch: int
    event_ids: tuple[str, ...]


MAX_TRACKED_USER_TRANSCRIPTS = 4096
MAX_CAPTION_CHARS = 160


@dataclass(frozen=True, slots=True)
class CaptionFrame:
    """Speculative display-only caption (truth tier T0): revisable, never persisted."""

    role: Literal["user", "assistant"]
    text: str
    final: bool


@dataclass(frozen=True, slots=True)
class DelegateRecord:
    """One delegate's session view: task summary plus the latest progress slot (R103)."""

    summary: str
    state: DelegateState
    channel: str = "codex"
    progress_summary: str | None = None
    internal_activity: int = 0
    elapsed: float = 0.0


# Distinguishes "kwarg omitted, preserve the previous progress slot" from an
# explicit None, so handoff/dispatch call sites need no change.
_UNSET: Any = object()


@dataclass(frozen=True, slots=True)
class RealtimeSnapshot:
    version: int
    active_delegates: tuple[tuple[str, DelegateRecord], ...]
    spoken_event_ids: tuple[str, ...]
    interrupted_event_ids: tuple[str, ...]


@dataclass(slots=True)
class _ProviderTurn:
    phase: ProviderTurnPhase
    user_input_revision: int
    locally_fenced: bool = False
    defer_playback_fence: bool = False


@dataclass(frozen=True, slots=True)
class _PendingResponse:
    intents: tuple[HostResponseIntent, ...]
    provider_intent: HostResponseIntent
    user_input_revision: int


class RealtimeSession:
    def __init__(
        self,
        *,
        provider: RealtimeFrontBrain,
        playback: PlaybackRegistry,
        id_factory: Callable[[], str],
        on_spoken: Callable[[str], None] | None = None,
        on_delivery: Callable[[PlaybackCompletion], None] | None = None,
        on_provider_connected: Callable[[SessionIdentity], Awaitable[None]] | None = None,
        clock: Clock | None = None,
    ) -> None:
        self._provider = provider
        self._playback = playback
        self._id_factory = id_factory
        self._on_spoken = on_spoken or (lambda _text: None)
        self._on_delivery = on_delivery or (lambda _completion: None)
        self._on_provider_connected = on_provider_connected
        self._clock = clock or RealClock()
        self._user_hold_since: float | None = None
        self._user_input_revision = 0
        self._user_transcript_ids: deque[tuple[int, str]] = deque()
        self._user_transcript_seen: set[tuple[int, str]] = set()
        self._user_turn_ids: deque[tuple[int, str]] = deque()
        self._user_turn_seen: set[tuple[int, str]] = set()
        self._user_caption_item: str | None = None
        self._user_caption_text = ""
        self._assistant_caption_response: str | None = None
        self._assistant_caption_text = ""
        self._session_epoch = 0
        self._snapshot_version = 0
        self._response_request_lock = asyncio.Lock()
        self._pending_responses: deque[_PendingResponse] = deque()
        self._awaiting_user_response = False
        self._pending_response_id: str | None = None
        self._fence_next_response = False
        self._fence_interruption: FenceInterruption | None = None
        self._pending_audio: list[bytes] = []
        self._pending_audio_bytes = 0
        self._provider_response_id: str | None = None
        self._host_preempt_response_id: str | None = None
        self._host_preempt_pending = False
        self._spoken_response_id: str | None = None
        self._suppressed_response_ids: set[str] = set()
        self._provider_transcript = ""
        self._last_opened_generation: PlaybackGeneration | None = None
        self._guard_handoff_generation: PlaybackGeneration | None = None
        self._provider_turns: OrderedDict[tuple[int, str], _ProviderTurn] = OrderedDict()
        self._response_items: dict[tuple[int, str], tuple[HostContextItem, ...]] = {}
        self._injected_event_epochs: OrderedDict[str, int] = OrderedDict()
        self._retained_suggestion_injection_ids: set[str] = set()
        self._responded_event_ids: OrderedDict[str, None] = OrderedDict()
        self._delegates: dict[str, DelegateRecord] = {}
        self._spoken_event_ids: list[str] = []
        self._interrupted_event_ids: list[str] = []
        self.floor = Floor()

    @property
    def current_generation(self) -> PlaybackGeneration | None:
        return self._playback.current

    @property
    def active_provider_response_id(self) -> str | None:
        return self._provider_response_id

    @property
    def session_epoch(self) -> int:
        return self._session_epoch

    @property
    def user_input_revision(self) -> int:
        return self._user_input_revision

    @property
    def provider_idle(self) -> bool:
        return (
            not self._pending_responses
            and not self._awaiting_user_response
            and self._provider_response_id is None
        )

    @property
    def foreground_idle(self) -> bool:
        return (
            self.provider_idle
            and self._playback.current is None
            and not self._playback.has_unreported_fence
        )

    def provider_turn_phase(self, response_id: str | None) -> ProviderTurnPhase | None:
        turn = self._provider_turn(response_id)
        return None if turn is None else turn.phase

    def provider_turn_user_input_revision(self, response_id: str | None) -> int | None:
        turn = self._provider_turn(response_id)
        return None if turn is None else turn.user_input_revision

    def response_event_ids(self, response_id: str) -> tuple[str, ...]:
        return tuple(
            item.event_id for item in self._response_items.get(self._turn_key(response_id), ())
        )

    def provider_turn_was_fenced(self, response_id: str | None) -> bool:
        turn = self._provider_turn(response_id)
        return turn is not None and turn.locally_fenced

    def response_has_spoken(self, response_id: str | None) -> bool:
        return response_id is not None and response_id == self._spoken_response_id

    def event_was_spoken(self, event_id: str) -> bool:
        return event_id in self._spoken_event_ids

    def host_event_is_deduplicated(self, event_id: str) -> bool:
        return event_id in self._responded_event_ids

    def take_fence_interruption(self) -> FenceInterruption | None:
        interruption = self._fence_interruption
        self._fence_interruption = None
        return interruption

    def arm_next_response_fence(self) -> None:
        """Fence the next provider response before it can own playback.

        Used by host-reserved confirmation turns. Repeated arming is deliberately
        idempotent so one user speech item cannot consume multiple responses.
        """
        if self._fence_next_response:
            return
        if self._pending_responses:
            self._mark_head_pending_fenced()
        self._fence_next_response = True
        self._advance_snapshot()

    async def connect(self, *, tools: tuple[dict[str, object], ...]) -> None:
        identity = await self._provider.connect(tools=tools)  # type: ignore[arg-type]
        if identity.epoch <= self._session_epoch:
            raise ValueError("provider session epoch must increase")
        self._session_epoch = identity.epoch
        if self._on_provider_connected is not None:
            await self._on_provider_connected(identity)
        self._advance_snapshot()

    async def deliver_host_item(self, item: HostContextItem) -> bool:
        delivery = await self.deliver_host_response(HostResponseIntent.host_fact(item))
        return delivery.accepted

    async def deliver_host_response(
        self,
        intent: HostResponseIntent,
        *,
        as_user_activation: bool = False,
    ) -> HostResponseDelivery:
        return await self._deliver_host_response(
            intent,
            allow_playback_overlap=False,
            confirmation_timeout=None,
            as_user_activation=as_user_activation,
        )

    async def deliver_preemptive_host_response(
        self,
        intent: HostResponseIntent,
        *,
        confirmation_timeout: float | None = None,
        response_allowed: Callable[[], bool] | None = None,
        as_user_activation: bool = False,
    ) -> HostResponseDelivery:
        return await self._deliver_host_response(
            intent,
            allow_playback_overlap=True,
            confirmation_timeout=confirmation_timeout,
            response_allowed=response_allowed,
            as_user_activation=as_user_activation,
        )

    async def _deliver_host_response(
        self,
        intent: HostResponseIntent,
        *,
        allow_playback_overlap: bool,
        confirmation_timeout: float | None,
        response_allowed: Callable[[], bool] | None = None,
        as_user_activation: bool = False,
    ) -> HostResponseDelivery:
        async with self._response_request_lock:
            item = intent.item
            if item.event_id in self._responded_event_ids:
                return HostResponseDelivery(accepted=False)
            ready = self.provider_idle if allow_playback_overlap else self.foreground_idle
            if not ready:
                raise RealtimeDeliveryError("foreground became busy before host delivery")
            injected_epoch = self._injected_event_epochs.get(item.event_id)
            if item.kind == "tool_output":
                if injected_epoch is None:
                    raise ValueError("tool output must be confirmed before response")
                if (
                    injected_epoch != self._session_epoch
                    and intent.kind != "delegation_acknowledgement"
                ):
                    return HostResponseDelivery(accepted=False)
            elif injected_epoch is not None and injected_epoch != self._session_epoch:
                return HostResponseDelivery(accepted=False)
            elif injected_epoch is None:
                await self._inject_host_item(
                    item,
                    confirmation_timeout=confirmation_timeout,
                    as_user_activation=as_user_activation,
                )
                injected_epoch = self._injected_event_epochs[item.event_id]
            if response_allowed is not None and not response_allowed():
                return HostResponseDelivery(accepted=False, injection_epoch=injected_epoch)
            await self._create_response(intent, event_ids=(item.event_id,))
            self._pending_responses.append(
                _PendingResponse(
                    intents=(intent,),
                    provider_intent=intent,
                    user_input_revision=self._user_input_revision,
                )
            )
            return HostResponseDelivery(accepted=True, injection_epoch=injected_epoch)

    async def request_tool_continuation(
        self,
        intents: tuple[HostResponseIntent, ...],
        *,
        origin_spoken: bool = False,
    ) -> ContinuationRequestResult:
        async with self._response_request_lock:
            if not intents:
                raise ValueError("tool continuation requires at least one intent")
            # Qwen permits only one provider inference (including pre-start) at a
            # time, and a continuation's audio would fence pre-tool-call speech
            # still audible on the renderer (#49) — wait out playback like
            # foreground_idle's playback sub-conditions do.
            if (
                self._pending_responses
                or self._provider_response_id is not None
                or self._playback.current is not None
                or self._playback.has_unreported_fence
            ):
                return "retryable"
            for intent in intents:
                item = intent.item
                if item.kind != "tool_output":
                    raise ValueError("tool continuation requires tool output")
                if item.event_id in self._responded_event_ids:
                    return "rejected"
                injected_epoch = self._injected_event_epochs.get(item.event_id)
                if injected_epoch is None:
                    raise ValueError("tool output must be confirmed before continuation")
                if (
                    injected_epoch != self._session_epoch
                    and intent.kind != "delegation_acknowledgement"
                ):
                    return "rejected"
            provider_intent = self._merge_continuation_intents(
                intents,
                origin_spoken=origin_spoken,
            )
            await self._create_response(
                provider_intent,
                event_ids=tuple(intent.item.event_id for intent in intents),
            )
            self._pending_responses.append(
                _PendingResponse(
                    intents=intents,
                    provider_intent=provider_intent,
                    user_input_revision=self._user_input_revision,
                )
            )
            return "requested"

    async def _create_response(
        self,
        intent: HostResponseIntent,
        *,
        event_ids: tuple[str, ...],
    ) -> None:
        try:
            await self._provider.create_response(intent)
        except Exception as exc:
            raise RealtimeDeliveryError(f"response request failed: {exc}") from exc
        for event_id in event_ids:
            self._responded_event_ids[event_id] = None
            self._responded_event_ids.move_to_end(event_id)
        self._prune_host_event_ledgers(event_ids)

    def _prune_host_event_ledgers(self, completed_event_ids: tuple[str, ...]) -> None:
        prunable = set(completed_event_ids) | self._responded_event_ids.keys()
        for event_id in tuple(self._injected_event_epochs):
            if len(self._injected_event_epochs) <= MAX_TRACKED_HOST_EVENTS:
                break
            if event_id in prunable:
                del self._injected_event_epochs[event_id]
                self._retained_suggestion_injection_ids.discard(event_id)
        while len(self._responded_event_ids) > MAX_TRACKED_HOST_EVENTS:
            self._responded_event_ids.popitem(last=False)
        self._advance_snapshot()

    async def inject_tool_output(self, item: HostContextItem) -> bool:
        if item.kind != "tool_output":
            raise ValueError("only tool output can bypass host response gating")
        return await self._inject_host_item(item)

    async def _inject_host_item(
        self,
        item: HostContextItem,
        *,
        confirmation_timeout: float | None = None,
        as_user_activation: bool = False,
    ) -> bool:
        if item.event_id in self._injected_event_epochs:
            return False
        try:
            if as_user_activation:
                identity = await self._provider.inject_host_item(
                    item,
                    confirmation_timeout=confirmation_timeout,
                    as_user_activation=True,
                )
            elif confirmation_timeout is None:
                identity = await self._provider.inject_host_item(item)
            else:
                identity = await self._provider.inject_host_item(
                    item,
                    confirmation_timeout=confirmation_timeout,
                )
        except ItemDeliveryUncertainError:
            raise
        except Exception as exc:
            raise RealtimeDeliveryError(f"host item injection failed: {exc}") from exc
        if (
            identity.session_epoch != self._session_epoch
            or identity.host_item_id != item.host_item_id
        ):
            raise ValueError("host item confirmation identity mismatch")
        self._injected_event_epochs[item.event_id] = self._session_epoch
        self._injected_event_epochs.move_to_end(item.event_id)
        if len(self._injected_event_epochs) > MAX_PENDING_HOST_EVENTS:
            evicted_event_id, _epoch = self._injected_event_epochs.popitem(last=False)
            self._retained_suggestion_injection_ids.discard(evicted_event_id)
        self._advance_snapshot()
        return True

    async def accept(self, event: RealtimeFrontBrainEvent) -> bool:
        if event.session_epoch != self._session_epoch:
            return False
        if isinstance(event, ToolCallReady):
            response_id = event.response_id or self._provider_response_id
            if response_id is not None and self._turn_key(response_id) in self._response_items:
                # Host-created responses narrate an injected fact or continue an
                # already accepted tool protocol. They never authorize a new tool.
                return False
            return True
        if isinstance(event, ResponseStarted):
            self._awaiting_user_response = False
            turn = self._provider_turn(event.response_id)
            if turn is not None and (turn.locally_fenced or turn.phase != "active"):
                return False
            if turn is not None and self._fence_next_response:
                # An active recorded turn must not coexist with an armed pre-start
                # fence (R118); the known entry was closed at the oversized-delta
                # gate. A provider protocol violation that recreates the shape is
                # rejected loudly instead of killing the session.
                print("[realtime-diagnostic] armed_fence_turn_conflict", flush=True)
                turn.locally_fenced = True
                turn.phase = "cancel_requested"
                if self._pending_response_id == event.response_id:
                    self._clear_pending_audio()
                self._advance_snapshot()
                await self._provider.cancel_response(event.response_id)
                return False
            if self.floor.state == "user_speaking":
                await self._fence_pending_response(event.response_id)
                return False
            if turn is None and self._fence_next_response:
                await self._fence_pending_response(event.response_id)
                return False
            if self._provider_response_id is not None:
                if self._provider_response_id != event.response_id:
                    self._mark_locally_fenced(event.response_id)
                return False
            if self._pending_response_id not in {None, event.response_id}:
                self._clear_pending_audio()
                return False
            if turn is None:
                turn = self._record_provider_turn(event.response_id)
            self._provider_response_id = event.response_id
            self._spoken_response_id = None
            self._provider_transcript = ""
            if self._pending_responses:
                pending = self._pending_responses.popleft()
                self._response_items[self._turn_key(event.response_id)] = tuple(
                    intent.item for intent in pending.intents
                )
                if (
                    pending.provider_intent.origin_spoken
                    and pending.user_input_revision == self._user_input_revision
                ):
                    # #55 live: provider instructions are advisory. The host's
                    # played-origin proof owns audible acknowledgement semantics.
                    self._suppressed_response_ids.add(event.response_id)
            if (
                self._pending_audio
                and event.response_id not in self._suppressed_response_ids
                and self._open_audio_response(event.response_id)
            ):
                for pcm in self._pending_audio:
                    self._playback.push_audio(
                        session_epoch=self._session_epoch,
                        response_id=event.response_id,
                        pcm=pcm,
                    )
            self._clear_pending_audio()
            return True
        if isinstance(event, ResponseAudioDelta):
            suppress_pending = (
                self._provider_response_id is None
                and bool(self._pending_responses)
                and self._pending_responses[0].provider_intent.origin_spoken
                and self._pending_responses[0].user_input_revision == self._user_input_revision
            )
            if event.response_id in self._suppressed_response_ids or suppress_pending:
                self._suppressed_response_ids.add(event.response_id)
                return False
            if self.floor.state == "user_speaking":
                if self._pending_responses:
                    await self._fence_pending_response(event.response_id)
                return False
            turn = self._provider_turn(event.response_id)
            if turn is None:
                if self._fence_next_response:
                    await self._fence_pending_response(event.response_id)
                    return False
                if not self._pending_responses:
                    return False
                if self._pending_response_id not in {None, event.response_id}:
                    return False
                if self._pending_audio_bytes + len(event.pcm) > MAX_PREMAP_AUDIO_BYTES:
                    self._clear_pending_audio()
                    return False
                turn = self._record_provider_turn(event.response_id)
            if turn.locally_fenced or turn.phase != "active":
                return False
            if self._playback.push_audio(
                session_epoch=self._session_epoch,
                response_id=event.response_id,
                pcm=event.pcm,
            ):
                return True
            if self._provider_response_id == event.response_id:
                if not self._open_audio_response(event.response_id):
                    return False
                return self._playback.push_audio(
                    session_epoch=self._session_epoch,
                    response_id=event.response_id,
                    pcm=event.pcm,
                )
            if self._pending_audio_bytes + len(event.pcm) > MAX_PREMAP_AUDIO_BYTES:
                self._clear_pending_audio()
                return False
            self._pending_response_id = event.response_id
            self._pending_audio.append(event.pcm)
            self._pending_audio_bytes += len(event.pcm)
            return True
        if isinstance(event, ResponseTranscriptFinal):
            if event.response_id in self._suppressed_response_ids:
                return False
            if self._playback.set_transcript(
                session_epoch=self._session_epoch,
                response_id=event.response_id,
                text=event.text,
            ):
                return True
            turn = self._provider_turn(event.response_id)
            if turn is not None and (turn.locally_fenced or turn.phase != "active"):
                return False
            if self._provider_response_id == event.response_id:
                self._provider_transcript = event.text
                return True
            return False
        if isinstance(event, ResponseTerminal):
            turn = self._provider_turn(event.response_id)
            if turn is None:
                # A pre-start fence has no provider response ID to cancel. If
                # its first observable event is a terminal, it consumes the
                # one-shot fence and releases the fenced pending's inference
                # slot. Without an armed fence an unknown terminal must not
                # touch a live pending response (R118).
                if self._fence_next_response:
                    self._fence_next_response = False
                    self._pop_fenced_pending()
                return False
            if turn.phase in {"completed", "cancelled", "failed"}:
                return False
            self._awaiting_user_response = False
            turn.phase = event.status
            if self._provider_response_id == event.response_id:
                self._provider_response_id = None
                self._provider_transcript = ""
            if self._pending_response_id == event.response_id:
                self._clear_pending_audio()
            if event.status == "completed":
                if event.response_id in self._suppressed_response_ids:
                    self._suppressed_response_ids.discard(event.response_id)
                    self._finish_response_authority(event.response_id)
                    return True
                self._playback.mark_provider_terminal(
                    session_epoch=self._session_epoch,
                    response_id=event.response_id,
                )
                return True
            self._suppressed_response_ids.discard(event.response_id)
            self._mark_response_interrupted(event.response_id)
            current = self._playback.current
            if turn.defer_playback_fence:
                if (
                    current is not None
                    and current.session_epoch == event.session_epoch
                    and current.response_id == event.response_id
                ):
                    self._playback.mark_provider_terminal(
                        session_epoch=self._session_epoch,
                        response_id=event.response_id,
                        disposition="interrupted",
                    )
                elif not self.response_has_spoken(event.response_id):
                    self._finish_response_authority(event.response_id)
                self._advance_snapshot()
                return True
            if (
                current is None
                or current.session_epoch != event.session_epoch
                or current.response_id != event.response_id
            ):
                if not self.response_has_spoken(event.response_id):
                    self._finish_response_authority(event.response_id)
                return True
            generation = self._playback.fence_current()
            if generation is not None:
                self._mark_locally_fenced(generation.response_id)
                self._mark_response_interrupted(generation.response_id)
                self._advance_snapshot()
            return True
        if isinstance(event, UserSpeechStarted):
            # Floor only. Fencing the renderer here would mark the origin turn
            # locally_fenced and suppress dispatch of a ToolCallReady still owned by
            # that response (user barge-in != abandon tool protocol state); the local
            # onset detector remains the renderer barge-in path.
            self.floor = self.floor.on_user_speak_start(event.speech_id)
            self._accept_user_turn(event.provider_item_id or f"speech:{event.speech_id}")
            self._user_hold_since = self._clock.now()
            return True
        if isinstance(event, UserSpeechEnded):
            before = self.floor
            self.floor = self.floor.on_user_speak_end(event.speech_id)
            if event.provider_item_id is not None:
                self._replace_user_turn_identity(
                    f"speech:{event.speech_id}",
                    event.provider_item_id,
                )
            if self.floor.state != "user_speaking":
                self._user_hold_since = None
            return self.floor != before
        if isinstance(event, (UserTranscriptFinal, UserTranscriptFailed)):
            if not self._accept_user_transcript_terminal(event.item_id):
                return False
            self._accept_user_turn(event.item_id)
            if isinstance(event, UserTranscriptFailed):
                return True
            self._awaiting_user_response = True
            return True
        return False

    def _accept_user_transcript_terminal(self, item_id: str) -> bool:
        key = (self._session_epoch, item_id)
        if key in self._user_transcript_seen:
            return False
        self._user_transcript_seen.add(key)
        self._user_transcript_ids.append(key)
        if len(self._user_transcript_ids) > MAX_TRACKED_USER_TRANSCRIPTS:
            self._user_transcript_seen.discard(self._user_transcript_ids.popleft())
        return True

    def _accept_user_turn(self, item_id: str) -> bool:
        key = (self._session_epoch, item_id)
        if key in self._user_turn_seen:
            return False
        self._user_turn_seen.add(key)
        self._user_turn_ids.append(key)
        if len(self._user_turn_ids) > MAX_TRACKED_USER_TRANSCRIPTS:
            self._user_turn_seen.discard(self._user_turn_ids.popleft())
        self._user_input_revision += 1
        return True

    def _replace_user_turn_identity(self, previous_item_id: str, item_id: str) -> bool:
        previous_key = (self._session_epoch, previous_item_id)
        key = (self._session_epoch, item_id)
        if previous_key not in self._user_turn_seen or key in self._user_turn_seen:
            return False
        try:
            index = self._user_turn_ids.index(previous_key)
        except ValueError:
            return False
        self._user_turn_ids[index] = key
        self._user_turn_seen.remove(previous_key)
        self._user_turn_seen.add(key)
        return True

    async def local_speech_onset(self, speech_id: str) -> None:
        # The local energy detector is a barge-in signal only: it fences the audible
        # renderer and cancels active provider inference, but never takes the
        # user_speaking floor. Floor ownership belongs to provider VAD alone —
        # a local random ID would overwrite the provider speech ID and the matching
        # provider end could no longer release the floor (2026-08-05 live regression).
        del speech_id
        self._host_preempt_pending = False
        await self._fence_and_cancel_active_response()

    async def host_preempt(self) -> bool:
        if self.floor.state == "user_speaking":
            return False
        response_id = self._provider_response_id
        generation = self._playback.current
        if (
            response_id is not None
            and generation is not None
            and generation.session_epoch != self._session_epoch
            and generation.response_id == response_id
        ):
            return False
        if response_id is not None:
            turn = self._record_provider_turn(response_id)
            if turn.phase == "cancel_requested":
                return False
            turn.phase = "cancel_requested"
            turn.defer_playback_fence = True
            self._host_preempt_response_id = response_id
            await self._provider.cancel_response(response_id)
            return True
        if generation is not None and generation.session_epoch == self._session_epoch:
            turn = self._provider_turn(generation.response_id)
            if turn is not None and not turn.defer_playback_fence:
                turn.defer_playback_fence = True
                self._host_preempt_response_id = generation.response_id
                return True
        preempted = await self._fence_and_cancel_active_response()
        if preempted and self._fence_next_response:
            self._host_preempt_pending = True
        return preempted

    def expire_host_preempt(self, generation: PlaybackGeneration | None) -> bool:
        response_id = self._host_preempt_response_id
        if response_id is None:
            if generation is not None or not self._host_preempt_pending:
                return False
            self._host_preempt_pending = False
            if self._playback.current is None:
                self._playback.fence_current(alert=True)
            self._advance_snapshot()
            return True
        turn = self._provider_turn(response_id)
        if turn is None or not turn.defer_playback_fence:
            return False
        turn.defer_playback_fence = False
        self._host_preempt_response_id = None
        current = self._playback.current
        fenced = None
        if generation is not None and current == generation:
            fenced = self._playback.fence_current(alert=True)
        elif generation is None and self._host_preempt_pending and current is None:
            self._playback.fence_current(alert=True)
        self._host_preempt_pending = False
        if fenced is not None and fenced.session_epoch == self._session_epoch:
            self._mark_locally_fenced(fenced.response_id)
        self._mark_response_interrupted(response_id)
        self._advance_snapshot()
        return True

    async def _fence_and_cancel_active_response(self) -> bool:
        generation = self._playback.fence_current()
        fenced = generation is not None
        generation_owns_provider = (
            generation is not None and generation.session_epoch == self._session_epoch
        )
        if generation_owns_provider:
            assert generation is not None
            self._mark_locally_fenced(generation.response_id)
            self._mark_response_interrupted(generation.response_id)
            self._advance_snapshot()
        response_id = self._provider_response_id
        if response_id is not None:
            if (
                generation is not None
                and not generation_owns_provider
                and generation.response_id == response_id
            ):
                return fenced
            turn = self._record_provider_turn(response_id)
            if turn.phase == "cancel_requested":
                turn.defer_playback_fence = False
                if self._host_preempt_response_id == response_id:
                    self._host_preempt_response_id = None
                return fenced
            turn.locally_fenced = True
            turn.phase = "cancel_requested"
            if (
                generation is None
                or not generation_owns_provider
                or generation.response_id != response_id
            ):
                self._mark_response_interrupted(response_id)
                self._advance_snapshot()
            await self._provider.cancel_response(response_id)
            return True
        if self._pending_response_id is None:
            # response.create may already be in flight without a provider response ID
            # yet (pre-start window). Arm a one-shot fence so the next unowned
            # ResponseStarted / pre-map AudioDelta is fenced instead of played. The
            # fenced pending stays queued: it still owns the single provider
            # inference slot, so no second response.create can go out until a
            # consumption event pops it (R118).
            if self._pending_responses and not self._fence_next_response:
                self._fence_next_response = True
                self._mark_head_pending_fenced()
                self._advance_snapshot()
                return True
            return fenced
        response_id = self._pending_response_id
        turn = self._record_provider_turn(response_id)
        turn.locally_fenced = True
        turn.phase = "cancel_requested"
        self._provider_response_id = response_id
        self._abandon_pending_response()
        self._clear_pending_audio()
        self._advance_snapshot()
        await self._provider.cancel_response(response_id)
        return True

    async def _fence_pending_response(self, response_id: str) -> None:
        """Fence a response before it owns a playback generation."""
        armed = self._fence_next_response
        self._fence_next_response = False
        turn = self._record_provider_turn(response_id)
        turn.locally_fenced = True
        turn.phase = "cancel_requested"
        # ResponseStarted has now named the inference that consumed the armed
        # pre-start request. It keeps the provider slot until its matching
        # terminal; otherwise a Guard could emit a second response.create while
        # cancellation of this response is still in flight.
        self._provider_response_id = response_id
        if self._host_preempt_pending:
            self._host_preempt_response_id = response_id
            turn.defer_playback_fence = True
        if armed:
            # The arm branch already emitted the receipt for this pending (R118);
            # consumption only releases the inference slot.
            self._pop_fenced_pending()
        else:
            self._abandon_pending_response()
        self._clear_pending_audio()
        self._advance_snapshot()
        await self._provider.cancel_response(response_id)

    def _mark_head_pending_fenced(self) -> tuple[str, ...]:
        if not self._pending_responses:
            return ()
        pending = self._pending_responses[0]
        items = tuple(intent.item for intent in pending.intents)
        event_ids = tuple(item.event_id for item in items)
        for event_id in event_ids:
            self._append_once(self._interrupted_event_ids, event_id)
        self._release_suggestion_event_authority(items)
        self._fence_interruption = FenceInterruption(
            session_epoch=self._session_epoch,
            event_ids=event_ids,
        )
        return event_ids

    def _pop_fenced_pending(self) -> None:
        if self._pending_responses:
            self._pending_responses.popleft()

    def _abandon_pending_response(self) -> tuple[str, ...]:
        event_ids = self._mark_head_pending_fenced()
        self._pop_fenced_pending()
        return event_ids

    def playback_started(self, utterance_id: str, generation_epoch: int) -> bool:
        started = self._playback.mark_started(utterance_id, generation_epoch)
        if started and self.floor.state == "idle":
            # Floor reflects audibility, so the grant lands on actual playback
            # start; a start ack racing barge-in must never take the user's floor.
            self.floor = self.floor.on_speak_start(utterance_id, USER_PRIORITY)
        return started

    def playback_done(
        self,
        utterance_id: str,
        generation_epoch: int,
        played_ms: int | None = None,
    ) -> bool:
        return self.complete_playback(utterance_id, generation_epoch, played_ms) is not None

    def complete_playback(
        self,
        utterance_id: str,
        generation_epoch: int,
        played_ms: int | None = None,
    ) -> PlaybackCompletion | None:
        completion = self._playback.ack_done(utterance_id, generation_epoch, played_ms)
        if completion is None:
            return None
        if completion.disposition != "spoken":
            self._release_interrupted_suggestion_authority(
                completion.response_id,
                session_epoch=completion.session_epoch,
            )
            self._finish_response_authority(
                completion.response_id,
                session_epoch=completion.session_epoch,
            )
            self._on_delivery(completion)
            self.floor = self.floor.on_speak_end(utterance_id)
            self._advance_snapshot()
            return completion
        for item in self._response_items.get(
            self._turn_key(completion.response_id, session_epoch=completion.session_epoch),
            (),
        ):
            self._append_once(self._spoken_event_ids, item.event_id)
            self._retained_suggestion_injection_ids.discard(item.event_id)
        self._finish_response_authority(
            completion.response_id,
            session_epoch=completion.session_epoch,
        )
        self._on_spoken(completion.text)
        self._on_delivery(completion)
        self.floor = self.floor.on_speak_end(utterance_id)
        self._advance_snapshot()
        return completion

    def playback_cleared(
        self,
        utterance_id: str,
        generation_epoch: int,
        played_ms: int | None = None,
    ) -> bool:
        completion = self._playback.record_cleared(utterance_id, generation_epoch, played_ms)
        if completion is None:
            return False
        self._release_interrupted_suggestion_authority(
            completion.response_id,
            session_epoch=completion.session_epoch,
        )
        self._finish_response_authority(
            completion.response_id,
            session_epoch=completion.session_epoch,
        )
        self._on_delivery(completion)
        self.floor = self.floor.on_speak_end(utterance_id)
        return True

    async def playback_stopped(
        self,
        utterance_id: str,
        generation_epoch: int,
        played_ms: int | None = None,
    ) -> bool:
        current = self._playback.current
        if (
            current is None
            or current.utterance_id != utterance_id
            or current.generation_epoch != generation_epoch
        ):
            return False
        generation = self._playback.fence_current()
        if generation is None:
            return False
        if generation.session_epoch == self._session_epoch:
            self._mark_locally_fenced(generation.response_id)
            self._mark_response_interrupted(generation.response_id)
            self._advance_snapshot()
        completion = self._playback.record_cleared(utterance_id, generation_epoch, played_ms)
        if completion is not None:
            self._finish_response_authority(
                completion.response_id,
                session_epoch=completion.session_epoch,
            )
            self._on_delivery(completion)
        self.floor = self.floor.on_speak_end(utterance_id)
        if (
            generation.session_epoch == self._session_epoch
            and self._provider_response_id == generation.response_id
        ):
            self._record_provider_turn(generation.response_id).phase = "cancel_requested"
            await self._provider.cancel_response(generation.response_id)
        return True

    def register_delegate(
        self,
        delegate_id: str,
        *,
        summary: str,
        state: DelegateState,
        channel: str = "codex",
        progress_summary: str | None = _UNSET,
        internal_activity: int = _UNSET,
        elapsed: float = _UNSET,
    ) -> None:
        if not delegate_id or not summary:
            raise ValueError("delegate_id and summary are required")
        previous = self._delegates.get(delegate_id)
        if progress_summary is _UNSET:
            progress_summary = None if previous is None else previous.progress_summary
        elif progress_summary is not None:
            progress_summary = str(progress_summary)[:PROGRESS_SUMMARY_LIMIT]
        if internal_activity is _UNSET:
            internal_activity = 0 if previous is None else previous.internal_activity
        if elapsed is _UNSET:
            elapsed = 0.0 if previous is None else previous.elapsed
        self._delegates[delegate_id] = DelegateRecord(
            summary=summary,
            state=state,
            channel=channel,
            progress_summary=progress_summary,
            internal_activity=internal_activity,
            elapsed=elapsed,
        )
        self._advance_snapshot()

    def delegate_state(self, delegate_id: str) -> DelegateState | None:
        delegate = self._delegates.get(delegate_id)
        return None if delegate is None else delegate.state

    def snapshot(self) -> RealtimeSnapshot:
        active = tuple(
            (delegate_id, record)
            for delegate_id, record in self._delegates.items()
            if record.state == "running"
        )
        return RealtimeSnapshot(
            version=self._snapshot_version,
            active_delegates=active,
            spoken_event_ids=tuple(self._spoken_event_ids),
            interrupted_event_ids=tuple(self._interrupted_event_ids),
        )

    async def reconnect(self, *, tools: tuple[dict[str, object], ...]) -> None:
        async with self._response_request_lock:
            await self._reconnect(tools=tools)

    async def _reconnect(self, *, tools: tuple[dict[str, object], ...]) -> None:
        self._guard_handoff_generation = None
        interrupted_response_ids: list[str] = []
        generation = self._playback.fence_current()
        if generation is not None and generation.session_epoch == self._session_epoch:
            interrupted_response_ids.append(generation.response_id)
        if (
            self._provider_response_id is not None
            and self._provider_response_id not in interrupted_response_ids
        ):
            interrupted_response_ids.append(self._provider_response_id)
        for response_id in interrupted_response_ids:
            self._mark_locally_fenced(response_id)
            self._mark_response_interrupted(response_id)
            self._finish_response_authority(response_id)
        self._revoke_retained_suggestion_injections()
        self._abandon_pending_responses()
        self._awaiting_user_response = False
        self._fence_next_response = False
        self._fence_interruption = None
        self._provider_response_id = None
        self._host_preempt_response_id = None
        self._host_preempt_pending = False
        self._spoken_response_id = None
        self._suppressed_response_ids.clear()
        self._provider_transcript = ""
        self._clear_pending_audio()
        # A reconnect must not inherit an orphaned floor hold from the old epoch.
        self.floor = Floor()
        self._user_hold_since = None
        await self._provider.close()
        await self.connect(tools=tools)
        snapshot = self.snapshot()
        host_item_id = self._id_factory()
        recovery = HostContextItem.recovery(
            host_item_id=host_item_id,
            event_id=f"{host_item_id}-event",
            content=self._recovery_content(snapshot),
        )
        identity = await self._provider.inject_host_item(recovery)
        if identity.session_epoch != self._session_epoch:
            raise ValueError("recovery confirmation identity mismatch")
        self._advance_snapshot()

    async def reconnect_for_guard(
        self,
        *,
        tools: tuple[dict[str, object], ...],
        old_generation: PlaybackGeneration,
        confirmation_timeout: float | None = None,
        history: tuple[RecoveryTurn, ...] = (),
        history_mode: Literal["none", "packed"] = "none",
    ) -> Literal["none", "empty", "packed", "degraded", "uncertain"]:
        async with self._response_request_lock:
            return await self._reconnect_for_guard(
                tools=tools,
                old_generation=old_generation,
                confirmation_timeout=confirmation_timeout,
                history=history,
                history_mode=history_mode,
            )

    async def _reconnect_for_guard(
        self,
        *,
        tools: tuple[dict[str, object], ...],
        old_generation: PlaybackGeneration,
        confirmation_timeout: float | None = None,
        history: tuple[RecoveryTurn, ...] = (),
        history_mode: Literal["none", "packed"] = "none",
    ) -> Literal["none", "empty", "packed", "degraded", "uncertain"]:
        """Replace provider authority while retaining one exact renderer generation."""
        if history_mode not in {"none", "packed"}:
            raise ValueError("unknown Guard history recovery arm")
        if old_generation.session_epoch != self._session_epoch:
            raise ValueError("guard handoff generation must belong to the current session")
        if old_generation != self._last_opened_generation:
            raise ValueError("guard handoff requires a known playback generation")
        current = self._playback.current
        if current is not None and current != old_generation:
            raise ValueError("guard handoff generation must be current")
        old_epoch = self._session_epoch
        response_ids = [old_generation.response_id]
        if (
            self._provider_response_id is not None
            and self._provider_response_id not in response_ids
        ):
            response_ids.append(self._provider_response_id)
        for response_id in response_ids:
            turn = self._provider_turn(response_id, session_epoch=old_epoch)
            if turn is not None:
                turn.defer_playback_fence = False
                if turn.phase not in {"completed", "cancelled", "failed"}:
                    turn.locally_fenced = True
                    turn.phase = "cancelled"
            self._mark_response_interrupted(response_id, session_epoch=old_epoch)
            self._finish_response_authority(response_id, session_epoch=old_epoch)
        self._playback.mark_provider_terminal(
            session_epoch=old_epoch,
            response_id=old_generation.response_id,
            disposition="interrupted",
        )
        self._revoke_retained_suggestion_injections()
        self._abandon_pending_responses()
        self._awaiting_user_response = False
        self._fence_next_response = False
        self._fence_interruption = None
        self._provider_response_id = None
        self._host_preempt_response_id = None
        self._host_preempt_pending = False
        self._spoken_response_id = None
        self._suppressed_response_ids.clear()
        self._provider_transcript = ""
        self._clear_pending_audio()
        if not (
            self.floor.state == "agent_speaking"
            and self.floor.utterance_id == old_generation.utterance_id
        ):
            self.floor = Floor()
        self._user_hold_since = None
        self._guard_handoff_generation = old_generation
        await self._provider.close()
        await self.connect(tools=tools)
        history_outcome: Literal["none", "empty", "packed", "degraded", "uncertain"] = "none"
        if history_mode != "none":
            history_outcome = "empty"
        if history_mode == "packed" and history:
            packed_content = self._packed_history_content(history)
            if packed_content:
                history_item_id = self._id_factory()
                dialogue_context = HostContextItem.dialogue_context(
                    host_item_id=history_item_id,
                    event_id=f"{history_item_id}-event",
                    content=packed_content,
                )
                try:
                    await self._provider.inject_host_item(
                        dialogue_context,
                        confirmation_timeout=confirmation_timeout,
                    )
                except ItemDeliveryUncertainError:
                    history_outcome = "uncertain"
                except RuntimeError:
                    history_outcome = "degraded"
                else:
                    history_outcome = "packed"
            else:
                history_outcome = "degraded"
        snapshot = self.snapshot()
        host_item_id = self._id_factory()
        recovery = HostContextItem.recovery(
            host_item_id=host_item_id,
            event_id=f"{host_item_id}-event",
            content=self._recovery_content(snapshot),
        )
        if confirmation_timeout is None:
            identity = await self._provider.inject_host_item(recovery)
        else:
            identity = await self._provider.inject_host_item(
                recovery,
                confirmation_timeout=confirmation_timeout,
            )
        if identity.session_epoch != self._session_epoch:
            raise ValueError("recovery confirmation identity mismatch")
        self._advance_snapshot()
        return history_outcome

    @staticmethod
    def _packed_history_content(history: tuple[RecoveryTurn, ...]) -> str:
        _fitted, content = pack_recovery_turns(history)
        return content

    def alert_guard_handoff(self, generation: PlaybackGeneration) -> bool:
        """Alert-fence the exact renderer generation retained for Guard handoff."""
        if self._guard_handoff_generation != generation:
            return False
        current = self._playback.current
        if current == generation:
            if not self._playback.alert_fence_generation(generation):
                return False
        elif current is None:
            self._playback.fence_current(alert=True)
        else:
            return False
        self._guard_handoff_generation = None
        self.floor = self.floor.on_speak_end(generation.utterance_id)
        self._advance_snapshot()
        return True

    def retire_playback_clear_unknown(self, generation: PlaybackGeneration) -> bool:
        """Release exact fenced playback without fabricating delivery evidence."""
        if not self._playback.retire_clear_unknown(generation):
            return False
        if self._guard_handoff_generation == generation:
            self._guard_handoff_generation = None
        self.floor = self.floor.on_speak_end(generation.utterance_id)
        self._advance_snapshot()
        return True

    def _abandon_pending_responses(self) -> None:
        for pending in self._pending_responses:
            for intent in pending.intents:
                event_id = intent.item.event_id
                self._responded_event_ids.pop(event_id, None)
                self._injected_event_epochs.pop(event_id, None)
        self._pending_responses.clear()

    @staticmethod
    def _recovery_content(snapshot: RealtimeSnapshot) -> str:
        header = [
            f"snapshot_version={snapshot.version}",
            f"active_work_count={len(snapshot.active_delegates)}",
        ]
        footer = [
            f"spoken_progress_count={len(snapshot.spoken_event_ids)}",
            f"interrupted_progress_count={len(snapshot.interrupted_event_ids)}",
        ]
        active_work: list[str] = []
        for index, (_delegate_id, record) in enumerate(snapshot.active_delegates):
            line = (
                f"active_work_channel={record.channel};"
                f"active_work={record.summary[:MAX_CONTINUATION_TASK_SUMMARY]};"
                f" state={record.state}"
            )
            if record.progress_summary:
                line += f"; progress={record.progress_summary[:120]}"
            remaining = len(snapshot.active_delegates) - index - 1
            trial = header + active_work + [line]
            if remaining:
                trial.append(f"active_work_omitted={remaining}")
            if len("\n".join(trial + footer)) > MAX_REALTIME_TEXT:
                break
            active_work.append(line)
        omitted = len(snapshot.active_delegates) - len(active_work)
        content_parts = header + active_work
        if omitted:
            content_parts.append(f"active_work_omitted={omitted}")
        return "\n".join(content_parts + footer)

    def caption_for(
        self, event: RealtimeFrontBrainEvent, *, accepted: bool | None = None
    ) -> CaptionFrame | None:
        """Project a transcript event into the display-only caption side channel.

        Captions carry the session's truth policy — epoch checks, fences, and
        response authorization — but are never session state: a caption is
        revisable evidence for the UI, not input to Floor, Memory, or delivery.
        ``accepted`` carries the session's verdict for events (user finals) whose
        authorization lives in ``accept`` rather than in per-response tracking.
        """
        if event.session_epoch != self._session_epoch:
            return None
        if isinstance(event, UserTranscriptDelta):
            if self._user_caption_item != event.item_id:
                self._user_caption_item = event.item_id
                self._user_caption_text = ""
            self._user_caption_text = (self._user_caption_text + event.text)[-MAX_CAPTION_CHARS:]
            return CaptionFrame(role="user", text=self._user_caption_text, final=False)
        if isinstance(event, UserTranscriptFinal):
            if accepted is False:
                return None
            self._user_caption_item = None
            self._user_caption_text = ""
            return CaptionFrame(role="user", text=event.text[-MAX_CAPTION_CHARS:], final=True)
        if isinstance(event, ResponseTranscriptDelta):
            if not self._caption_authorized(event.response_id):
                return None
            if self._assistant_caption_response != event.response_id:
                self._assistant_caption_response = event.response_id
                self._assistant_caption_text = ""
            self._assistant_caption_text = (self._assistant_caption_text + event.text)[
                -MAX_CAPTION_CHARS:
            ]
            return CaptionFrame(role="assistant", text=self._assistant_caption_text, final=False)
        if isinstance(event, ResponseTranscriptFinal):
            if not self._caption_authorized(event.response_id):
                return None
            self._assistant_caption_response = None
            self._assistant_caption_text = ""
            return CaptionFrame(role="assistant", text=event.text[-MAX_CAPTION_CHARS:], final=True)
        return None

    def _caption_authorized(self, response_id: str) -> bool:
        """Only a response the session actually owns may put speculative text on screen."""
        if response_id in self._suppressed_response_ids:
            return False
        turn = self._provider_turn(response_id)
        if turn is not None and turn.locally_fenced:
            return False
        if self._provider_response_id == response_id or self._pending_response_id == response_id:
            return True
        if self._turn_key(response_id) in self._response_items:
            return True
        current = self._playback.current
        return (
            current is not None
            and current.session_epoch == self._session_epoch
            and current.response_id == response_id
        )

    def reset_captions(self) -> None:
        """Drop speculative accumulators; the caller blanks the display."""
        self._user_caption_item = None
        self._user_caption_text = ""
        self._assistant_caption_response = None
        self._assistant_caption_text = ""

    async def wait_for_stale_hold(self, max_hold_s: float) -> bool:
        """Sleep on the injected clock until the active user hold turns stale.

        Returns False immediately when no user hold is active. The small margin
        past the deadline keeps the release comparison strict on a real clock.
        """
        if self.floor.state != "user_speaking" or self._user_hold_since is None:
            return False
        remaining = self._user_hold_since + max_hold_s - self._clock.now()
        if remaining > 0:
            await self._clock.sleep(remaining + 0.05)
        return True

    def release_stale_user_hold(self, max_hold_s: float) -> bool:
        """Release a user floor hold whose provider speech-end never arrived.

        Checked at each host-item delivery attempt. Because the final queued
        item has no later event to re-trigger delivery, a blocked flush also
        arms one clock-deadline wake (`wait_for_stale_hold`) in the service.
        """
        if self.floor.state != "user_speaking" or self._user_hold_since is None:
            return False
        if self._clock.now() - self._user_hold_since <= max_hold_s:
            return False
        self.floor = Floor()
        self._user_hold_since = None
        return True

    def _finish_response_authority(
        self,
        response_id: str,
        *,
        session_epoch: int | None = None,
    ) -> None:
        """A delivered response loses caption authority and its item bookkeeping."""
        epoch = self._session_epoch if session_epoch is None else session_epoch
        self._response_items.pop(self._turn_key(response_id, session_epoch=epoch), None)
        if epoch == self._session_epoch and self._assistant_caption_response == response_id:
            self._assistant_caption_response = None
            self._assistant_caption_text = ""

    def _advance_snapshot(self) -> None:
        self._snapshot_version += 1

    def _open_audio_response(self, response_id: str) -> bool:
        turn = self._provider_turn(response_id)
        if (
            self.floor.state == "user_speaking"
            or turn is None
            or turn.locally_fenced
            or turn.phase != "active"
        ):
            return False
        current = self._playback.current
        handoff = self._guard_handoff_generation
        if handoff is not None:
            if current == handoff:
                if not self._playback.switch_generation(handoff):
                    return False
                self.floor = self.floor.on_speak_end(handoff.utterance_id)
            elif current is not None:
                return False
            self._guard_handoff_generation = None
            current = None
        if current is not None and (
            current.session_epoch != self._session_epoch or current.response_id != response_id
        ):
            generation = self._playback.fence_current()
            if generation is not None:
                if generation.session_epoch == self._session_epoch:
                    previous = self._provider_turn(generation.response_id)
                    if previous is not None:
                        previous.defer_playback_fence = False
                    self._mark_locally_fenced(generation.response_id)
                    self._mark_response_interrupted(generation.response_id)
                    self._advance_snapshot()
        preempted_response_id = self._host_preempt_response_id
        if preempted_response_id is not None and preempted_response_id != response_id:
            previous = self._provider_turn(preempted_response_id)
            if previous is not None:
                previous.defer_playback_fence = False
            self._host_preempt_response_id = None
        self._host_preempt_pending = False
        self._last_opened_generation = self._playback.open_response(
            session_epoch=self._session_epoch,
            response_id=response_id,
        )
        self._spoken_response_id = response_id
        if self._provider_transcript:
            self._playback.set_transcript(
                session_epoch=self._session_epoch,
                response_id=response_id,
                text=self._provider_transcript,
            )
        return True

    def _clear_pending_audio(self) -> None:
        self._pending_response_id = None
        self._pending_audio.clear()
        self._pending_audio_bytes = 0

    def _merge_continuation_intents(
        self,
        intents: tuple[HostResponseIntent, ...],
        *,
        origin_spoken: bool = False,
    ) -> HostResponseIntent:
        acknowledgements = tuple(
            intent for intent in intents if intent.kind == "delegation_acknowledgement"
        )
        if acknowledgements:
            summary = "；".join(intent.task_summary or "" for intent in acknowledgements)[
                :MAX_CONTINUATION_TASK_SUMMARY
            ]
            return HostResponseIntent.delegation_acknowledgement(
                item=acknowledgements[0].item,
                task_summary=summary,
                # One voiced confirmation cannot replace every task in a
                # multi-tool batch or any synchronous results sharing it.
                origin_spoken=origin_spoken and len(intents) == 1,
            )
        return next(intent for intent in intents if intent.kind == "tool_result")

    def _turn_key(
        self,
        response_id: str,
        *,
        session_epoch: int | None = None,
    ) -> tuple[int, str]:
        return (self._session_epoch if session_epoch is None else session_epoch, response_id)

    def _provider_turn(
        self,
        response_id: str | None,
        *,
        session_epoch: int | None = None,
    ) -> _ProviderTurn | None:
        if response_id is None:
            return None
        return self._provider_turns.get(self._turn_key(response_id, session_epoch=session_epoch))

    def _record_provider_turn(self, response_id: str) -> _ProviderTurn:
        key = self._turn_key(response_id)
        turn = self._provider_turns.get(key)
        if turn is None:
            turn = _ProviderTurn(
                phase="active",
                user_input_revision=self._user_input_revision,
            )
            self._provider_turns[key] = turn
        self._provider_turns.move_to_end(key)
        while len(self._provider_turns) > MAX_TRACKED_PROVIDER_TURNS:
            self._provider_turns.popitem(last=False)
        return turn

    def _mark_locally_fenced(self, response_id: str) -> None:
        self._record_provider_turn(response_id).locally_fenced = True

    def _mark_response_interrupted(
        self,
        response_id: str,
        *,
        session_epoch: int | None = None,
    ) -> None:
        epoch = self._session_epoch if session_epoch is None else session_epoch
        items = self._response_items.get(self._turn_key(response_id, session_epoch=epoch), ())
        for item in items:
            self._append_once(self._interrupted_event_ids, item.event_id)
        self._release_suggestion_event_authority(items, session_epoch=epoch)

    def _release_interrupted_suggestion_authority(
        self,
        response_id: str,
        *,
        session_epoch: int | None = None,
    ) -> None:
        epoch = self._session_epoch if session_epoch is None else session_epoch
        self._release_suggestion_event_authority(
            self._response_items.get(self._turn_key(response_id, session_epoch=epoch), ()),
            session_epoch=epoch,
        )

    def _release_suggestion_event_authority(
        self,
        items: tuple[HostContextItem, ...],
        *,
        session_epoch: int | None = None,
    ) -> None:
        epoch = self._session_epoch if session_epoch is None else session_epoch
        for item in items:
            if item.event_id.startswith("suggestion:"):
                self._responded_event_ids.pop(item.event_id, None)
                if self._injected_event_epochs.get(item.event_id) == epoch:
                    self._retained_suggestion_injection_ids.add(item.event_id)

    def _revoke_retained_suggestion_injections(self) -> None:
        for event_id in self._retained_suggestion_injection_ids:
            self._injected_event_epochs.pop(event_id, None)
        self._retained_suggestion_injection_ids.clear()

    @staticmethod
    def _append_once(items: list[str], event_id: str) -> None:
        if event_id not in items:
            items.append(event_id)
