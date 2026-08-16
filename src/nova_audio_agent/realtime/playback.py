"""Provider-neutral renderer generation fencing and delivery acknowledgements."""

from __future__ import annotations

from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

IdFactory = Callable[[], str]
DeliveryDisposition = Literal["spoken", "interrupted", "suppressed"]
MAX_PLAYBACK_FRAME_BYTES = 64 * 1024
MAX_RENDERER_TOMBSTONES = 256

_ProviderIdentity = tuple[int, str]
_RendererIdentity = tuple[str, int]


@dataclass(frozen=True, slots=True)
class PlaybackGeneration:
    session_epoch: int
    generation_epoch: int
    generation_id: str
    utterance_id: str
    response_id: str


@dataclass(frozen=True, slots=True)
class PlaybackFrame:
    utterance_id: str
    generation_epoch: int
    sequence: int
    pcm: bytes


@dataclass(frozen=True, slots=True)
class PlaybackCompletion:
    session_epoch: int
    response_id: str
    utterance_id: str
    generation_epoch: int
    text: str
    disposition: DeliveryDisposition
    started: bool = False
    played_ms: int | None = None


@dataclass(slots=True)
class _GenerationState:
    identity: PlaybackGeneration
    next_sequence: int = 0
    transcript: str = ""
    provider_terminal: bool = False
    fenced: bool = False
    delivered: bool = False
    started: bool = False
    terminal_disposition: Literal["spoken", "interrupted"] = "spoken"


class PlaybackRegistry:
    def __init__(
        self,
        *,
        id_factory: IdFactory,
        on_frame: Callable[[PlaybackFrame], None],
        on_clear: Callable[[str, int], None],
        on_alert: Callable[[str | None, int | None], None] | None = None,
    ) -> None:
        self._id_factory = id_factory
        self._on_frame = on_frame
        self._on_clear = on_clear
        self._on_alert = on_alert or (lambda _utterance_id, _generation_epoch: None)
        self._generation_epoch = 0
        self._by_provider: dict[_ProviderIdentity, _GenerationState] = {}
        self._by_renderer: dict[_RendererIdentity, _GenerationState] = {}
        self._renderer_tombstones: deque[_RendererIdentity] = deque()
        self._renderer_tombstone_set: set[_RendererIdentity] = set()
        self._current_provider_identity: _ProviderIdentity | None = None

    @property
    def current(self) -> PlaybackGeneration | None:
        if self._current_provider_identity is None:
            return None
        return self._by_provider[self._current_provider_identity].identity

    @property
    def has_unreported_fence(self) -> bool:
        """True while a fenced generation still awaits its renderer delivery report.

        The renderer may still be audibly playing that generation until its
        cleared/stopped acknowledgement arrives, so the foreground is not idle.
        """
        return any(state.fenced and not state.delivered for state in self._by_provider.values())

    def open_response(self, *, session_epoch: int, response_id: str) -> PlaybackGeneration:
        if session_epoch < 1 or not response_id:
            raise ValueError("session_epoch and response_id are required")
        provider_identity = (session_epoch, response_id)
        if provider_identity in self._by_provider:
            raise ValueError("response already has a playback generation")
        if self._current_provider_identity is not None:
            raise ValueError("another playback generation is active")
        self._generation_epoch += 1
        identity = PlaybackGeneration(
            session_epoch=session_epoch,
            generation_epoch=self._generation_epoch,
            generation_id=self._id_factory(),
            utterance_id=self._id_factory(),
            response_id=response_id,
        )
        state = _GenerationState(identity=identity)
        self._by_provider[provider_identity] = state
        self._by_renderer[self._renderer_identity(identity)] = state
        self._current_provider_identity = provider_identity
        return identity

    def push_audio(self, *, session_epoch: int, response_id: str, pcm: bytes) -> bool:
        if type(pcm) is not bytes or not pcm or len(pcm) % 2:
            raise ValueError("pcm must be non-empty aligned PCM16 bytes")
        state = self._by_provider.get((session_epoch, response_id))
        if state is None or state.provider_terminal or state.fenced or state.delivered:
            return False
        for offset in range(0, len(pcm), MAX_PLAYBACK_FRAME_BYTES):
            frame = PlaybackFrame(
                utterance_id=state.identity.utterance_id,
                generation_epoch=state.identity.generation_epoch,
                sequence=state.next_sequence,
                pcm=pcm[offset : offset + MAX_PLAYBACK_FRAME_BYTES],
            )
            self._on_frame(frame)
            state.next_sequence += 1
        return True

    def set_transcript(self, *, session_epoch: int, response_id: str, text: str) -> bool:
        state = self._by_provider.get((session_epoch, response_id))
        if state is None or state.delivered:
            return False
        state.transcript = text
        return True

    def mark_provider_terminal(
        self,
        *,
        session_epoch: int,
        response_id: str,
        disposition: Literal["spoken", "interrupted"] = "spoken",
    ) -> bool:
        state = self._by_provider.get((session_epoch, response_id))
        if state is None or state.fenced or state.delivered:
            return False
        state.provider_terminal = True
        state.terminal_disposition = disposition
        if state.next_sequence == 0:
            self._retire(state)
        return True

    def fence_current(self, *, alert: bool = False) -> PlaybackGeneration | None:
        current = self.current
        if current is None:
            if alert:
                self._on_alert(None, None)
            return None
        fenced = self.alert_fence_generation(current) if alert else self.switch_generation(current)
        return current if fenced else None

    def switch_generation(self, generation: PlaybackGeneration) -> bool:
        """Clear one exact current generation before replacement audio is emitted."""
        return self._fence_generation(generation, alert=False)

    def alert_fence_generation(self, generation: PlaybackGeneration) -> bool:
        """Alert and clear one exact current generation at the Guard deadline."""
        return self._fence_generation(generation, alert=True)

    def retire_clear_unknown(self, generation: PlaybackGeneration) -> bool:
        """Retire a fenced generation whose renderer-clear outcome is unknowable."""
        state = self._state_for_generation(generation)
        if state is None or state.delivered or not state.fenced:
            return False
        self._retire(state)
        return True

    def mark_started(self, utterance_id: str, generation_epoch: int) -> bool:
        state = self._find(utterance_id, generation_epoch)
        if state is None or state.delivered or state.started:
            return False
        state.started = True
        return True

    def record_cleared(
        self,
        utterance_id: str,
        generation_epoch: int,
        played_ms: int | None,
    ) -> PlaybackCompletion | None:
        state = self._find(utterance_id, generation_epoch)
        if state is None or state.delivered or not state.fenced:
            return None
        state.delivered = True
        audible = state.started or (played_ms is not None and played_ms > 0)
        completion = PlaybackCompletion(
            session_epoch=state.identity.session_epoch,
            response_id=state.identity.response_id,
            utterance_id=state.identity.utterance_id,
            generation_epoch=state.identity.generation_epoch,
            text=state.transcript,
            disposition="interrupted" if audible else "suppressed",
            started=state.started,
            played_ms=played_ms,
        )
        self._retire(state)
        return completion

    def ack_done(
        self,
        utterance_id: str,
        generation_epoch: int,
        played_ms: int | None = None,
    ) -> PlaybackCompletion | None:
        state = self._find(utterance_id, generation_epoch)
        if (
            state is None
            or state.fenced
            or state.delivered
            or not state.provider_terminal
            or state.next_sequence == 0
        ):
            return None
        state.delivered = True
        disposition: DeliveryDisposition = state.terminal_disposition
        if disposition == "interrupted" and not (
            state.started or (played_ms is not None and played_ms > 0)
        ):
            disposition = "suppressed"
        completion = PlaybackCompletion(
            session_epoch=state.identity.session_epoch,
            response_id=state.identity.response_id,
            utterance_id=state.identity.utterance_id,
            generation_epoch=state.identity.generation_epoch,
            text=state.transcript,
            disposition=disposition,
            started=state.started,
            played_ms=played_ms,
        )
        self._retire(state)
        return completion

    def _find(self, utterance_id: str, generation_epoch: int) -> _GenerationState | None:
        renderer_identity = (utterance_id, generation_epoch)
        if renderer_identity in self._renderer_tombstone_set:
            return None
        return self._by_renderer.get(renderer_identity)

    def _fence_generation(self, generation: PlaybackGeneration, *, alert: bool) -> bool:
        state = self._state_for_generation(generation)
        if (
            state is None
            or state.fenced
            or state.delivered
            or self._current_provider_identity != self._provider_identity(generation)
        ):
            return False
        state.fenced = True
        self._current_provider_identity = None
        if alert:
            self._on_alert(generation.utterance_id, generation.generation_epoch)
        else:
            self._on_clear(generation.utterance_id, generation.generation_epoch)
        return True

    def _state_for_generation(
        self,
        generation: PlaybackGeneration,
    ) -> _GenerationState | None:
        state = self._by_renderer.get(self._renderer_identity(generation))
        if state is None or state.identity != generation:
            return None
        return state

    def _retire(self, state: _GenerationState) -> None:
        provider_identity = self._provider_identity(state.identity)
        renderer_identity = self._renderer_identity(state.identity)
        if self._by_provider.get(provider_identity) is state:
            del self._by_provider[provider_identity]
        if self._by_renderer.get(renderer_identity) is state:
            del self._by_renderer[renderer_identity]
        if self._current_provider_identity == provider_identity:
            self._current_provider_identity = None
        self._add_renderer_tombstone(renderer_identity)

    def _add_renderer_tombstone(self, renderer_identity: _RendererIdentity) -> None:
        if renderer_identity in self._renderer_tombstone_set:
            return
        if len(self._renderer_tombstones) == MAX_RENDERER_TOMBSTONES:
            expired = self._renderer_tombstones.popleft()
            self._renderer_tombstone_set.remove(expired)
        self._renderer_tombstones.append(renderer_identity)
        self._renderer_tombstone_set.add(renderer_identity)

    @staticmethod
    def _provider_identity(generation: PlaybackGeneration) -> _ProviderIdentity:
        return generation.session_epoch, generation.response_id

    @staticmethod
    def _renderer_identity(generation: PlaybackGeneration) -> _RendererIdentity:
        return generation.utterance_id, generation.generation_epoch
