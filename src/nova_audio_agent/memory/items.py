"""Channel items: the smallest unit on the blackboard (02-memory.md, section 1).

Channels are append-only: only appended to, never modified. The reason isn't tidiness — **a channel is a
trace** (D14); drop one observation and you can no longer replay, and you lose the ability to look back at
what an executor actually returned at the time.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

# Canonical form f"{channel}:{seq}". MemoryItem's natural primary key is (channel, seq).
MemoryRef = str

Trust = Literal["trusted_user", "trusted_system", "untrusted_external"]
Outcome = Literal["ok", "refused", "unknown", "failed"]


def make_ref(channel: str, seq: int) -> MemoryRef:
    return f"{channel}:{seq}"


def parse_ref(ref: MemoryRef) -> tuple[str, int]:
    """Split ref back into (channel, seq). This is the basis for the "parseable" check, one of the three
    origin_ref validations (B1)."""
    channel, _, raw_seq = ref.rpartition(":")
    if not channel or not raw_seq.isdigit():
        raise ValueError(f"不是合法的 MemoryRef：{ref!r}")
    return channel, int(raw_seq)


@dataclass(frozen=True, slots=True)
class MemoryItem:
    """An observation.

    trust is a first-class field, **for modeling reasons, not security** (D7): the blackboard holds what
    the user said, what sensors read, and what executors returned, all at once, and FastBrain needs to
    know who said what in order to speak naturally. It's a field with no gate attached; injection
    prevention is only a side effect.

    outcome=None means a non-result item (e.g., a user utterance).
    """

    channel: str
    seq: int  # monotonic within the channel
    ts: float  # virtual clock
    trust: Trust
    priority: int
    content: dict[str, Any]
    outcome: Outcome | None = None
    refs: tuple[MemoryRef, ...] = ()

    @property
    def ref(self) -> MemoryRef:
        return make_ref(self.channel, self.seq)


@dataclass(slots=True)
class Channel:
    """A channel. items only grows, never changes.

    Compression writes its output to summary without altering the original log;
    uncompressed is the count source for the per-channel watermark (D10).
    """

    name: str
    items: tuple[MemoryItem, ...] = ()
    summary: str | None = None
    uncompressed: int = 0

    def append(
        self,
        *,
        ts: float,
        trust: Trust,
        priority: int,
        content: dict[str, Any],
        outcome: Outcome | None = None,
        refs: tuple[MemoryRef, ...] = (),
    ) -> MemoryItem:
        """Append one item and return it. seq is assigned by the channel, ts is provided by the runtime —
        the model never touches either."""
        item = MemoryItem(
            channel=self.name,
            seq=len(self.items) + 1,
            ts=ts,
            trust=trust,
            priority=priority,
            content=content,
            outcome=outcome,
            refs=refs,
        )
        self.items = (*self.items, item)
        self.uncompressed += 1
        return item
