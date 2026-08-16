"""Exit of the speak axis: a sink that only forwards (01-spine.md, "text goes through
the streaming channel").

The sole reason it exists is to **make "no buffering" observable**: every time
`FastBrain.call()` emits a chunk, the sink records **the virtual moment right then**.
An implementation that buffers the whole stream and emits it all at once would
record a run of identical timestamps — that's what scenario 2 catches (R24).

**The timestamp is asked from the clock by the sink itself, not passed in by the
caller** (codex review round 2). If it were passed in, an implementation that
buffers fragments, flushes them all at the end, and backfills the originally
recorded timestamps could still fool that assertion — tested, all four passed.
A timestamp measured by the exit itself can't be faked: `now()` at the moment of
flush is, by definition, the moment of flush.

Stage C will have an implementation that writes text to CLI/TTS; its constructor
will inject the clock the same way.
"""

from __future__ import annotations

from dataclasses import dataclass
from collections.abc import Callable
from typing import Protocol

from nova_audio_agent.clock import Clock


@dataclass(frozen=True, slots=True)
class SpokenChunk:
    """A segment at the exit. ts is the virtual moment it **left the harness**, not
    the moment the model produced it."""

    ts: float
    utterance_id: str
    text: str


class SpeechSink(Protocol):
    def emit(self, utterance_id: str, text: str) -> None: ...

    def end(self, utterance_id: str) -> None: ...


class RecordingSink:
    """Records each segment along with the moment it left. The default
    implementation — when nothing is wired to a CLI, what was said still doesn't
    vanish into thin air."""

    def __init__(self, clock: Clock) -> None:
        self._clock = clock
        self.chunks: list[SpokenChunk] = []
        self.ended: list[tuple[float, str]] = []

    def emit(self, utterance_id: str, text: str) -> None:
        self.chunks.append(SpokenChunk(ts=self._clock.now(), utterance_id=utterance_id, text=text))

    def end(self, utterance_id: str) -> None:
        self.ended.append((self._clock.now(), utterance_id))

    def text_of(self, utterance_id: str) -> str:
        return "".join(chunk.text for chunk in self.chunks if chunk.utterance_id == utterance_id)

    def utterances(self) -> list[str]:
        """Full utterances in the order they appeared. Use this to assert "it spoke"."""
        order: list[str] = []
        for chunk in self.chunks:
            if chunk.utterance_id not in order:
                order.append(chunk.utterance_id)
        return [self.text_of(utterance_id) for utterance_id in order]


class CliSpeechSink:
    """Text CLI exit: every model delta is written as soon as it arrives."""

    def __init__(self, writer: Callable[[str], None]) -> None:
        self._writer = writer

    def emit(self, utterance_id: str, text: str) -> None:
        del utterance_id
        self._writer(text)

    def end(self, utterance_id: str) -> None:
        del utterance_id
        self._writer("\n")
