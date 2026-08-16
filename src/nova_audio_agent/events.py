"""The event table and the deterministic event queue (01-spine.md's ten rows, eleven kinds).

The historical Stage A baseline had seven rows and eight kinds; M1 adds delegate-attached
``progress`` as the eighth row/ninth kind. M2 adds renderer-acknowledged ``assistant_spoken``
as the ninth row/tenth kind. R136 adds delegate-attached ``observation`` as the tenth row/
eleventh kind. ``speak_start`` / ``speak_end`` still share one row.
Fields and branches a stage does not need yet remain no-ops, but **the types are all there**.

Sort key = (ts, kind_rank, seq):
- ts   virtual timestamp, stamped by the runtime at enqueue time
- kind_rank  only two values: deadline=1, everything else 0. At the same virtual instant, deadline is processed last
- seq  a globally monotonic enqueue counter, keeping FIFO order among the other kinds

Why kind_rank is needed (R16): a deadline is enqueued **at the moment of dispatch** (small seq),
while a handoff is enqueued **at the moment of completion** (large seq). Sorting only by (ts, seq)
would let a same-instant deadline cut in front of the handoff, so a delegate that "succeeded at
exactly the deadline instant" would get a false "I'm not sure" — directly violating termination
rule 1 in 05-executors.md (handoff wins).

The other half lives in runtime.py: kind_rank can only order events that are **already in the queue**;
making two same-instant events actually land on the same ts is a matter of the loop's branch ordering.
"""

from __future__ import annotations

import heapq
from dataclasses import dataclass, replace
from typing import Any, ClassVar, Literal

from nova_audio_agent.memory import MemoryRef, Outcome, Trust

# The routing class is bound by the runtime along the causal chain; the model can't touch it (R12). Defined on the spine side; ports.py references it.
RoutingClass = Literal["user_awaited", "ambient"]


def json_safe(value: Any) -> Any:
    """Recursively turn tuples into lists so event payloads survive a JSON round trip.

    This does exactly one thing: other types that aren't JSON-able (set, objects) are left
    for json.dumps to blow up on the spot — that's better than silently converting them to
    strings here. Better to blow up while writing the trace than to discover it only when
    comparing against a replay.
    """
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    return value


@dataclass(frozen=True, slots=True)
class UserInput:
    """One user utterance arriving from the transport layer. Wakes FastBrain, bypassing Surrogate."""

    KIND: ClassVar[str] = "user_input"

    text: str
    media_refs: tuple[str, ...] = ()
    ts: float = 0.0
    seq: int = -1

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"text": self.text}
        if self.media_refs:
            payload["media_refs"] = list(self.media_refs)
        return payload

    @classmethod
    def from_payload(cls, payload: dict[str, Any], *, ts: float, seq: int) -> UserInput:
        return cls(
            text=payload["text"],
            media_refs=tuple(payload.get("media_refs", ())),
            ts=ts,
            seq=seq,
        )


@dataclass(frozen=True, slots=True)
class HandoffEvent:
    """An observation once an executor finishes. origin_ref is carried back verbatim from DelegateSpec.

    trust is declared by the adapter and carried along with the handoff, not guessed by the
    main loop: `search`'s return is untrusted_external, while the simulator/HA's return is
    trusted_system, and none of HandoffPolicy's six fields has a place for it (that table is frozen).
    """

    KIND: ClassVar[str] = "handoff"

    channel: str
    delegate_id: str
    origin_ref: MemoryRef
    outcome: Outcome
    trust: Trust
    content: dict[str, Any]
    refs: tuple[MemoryRef, ...] = ()
    ts: float = 0.0
    seq: int = -1

    def __post_init__(self) -> None:
        # content is a free-form dict from the executor, the only one that goes into the trace.
        # A JSON round trip would turn nested tuples into lists, so the replayed event would no
        # longer equal the live one — the "equal entry by entry" green check would get quietly
        # broken by one adapter's writing habit. Normalize at the entry point rather than trust
        # every adapter to remember.
        object.__setattr__(self, "content", json_safe(self.content))

    def to_payload(self) -> dict[str, Any]:
        return {
            "channel": self.channel,
            "delegate_id": self.delegate_id,
            "origin_ref": self.origin_ref,
            "outcome": self.outcome,
            "trust": self.trust,
            "content": self.content,
            "refs": list(self.refs),
        }

    @classmethod
    def from_payload(cls, payload: dict[str, Any], *, ts: float, seq: int) -> HandoffEvent:
        return cls(
            channel=payload["channel"],
            delegate_id=payload["delegate_id"],
            origin_ref=payload["origin_ref"],
            outcome=payload["outcome"],
            trust=payload["trust"],
            content=payload["content"],
            refs=tuple(payload["refs"]),
            ts=ts,
            seq=seq,
        )


@dataclass(frozen=True, slots=True)
class ProgressEvent:
    """A bounded observation from an active run; it never owns termination."""

    KIND: ClassVar[str] = "progress"

    channel: str
    delegate_id: str
    op: str
    phase: Literal["started", "working"]
    internal_activity: int
    elapsed: float
    summary: str | None = None
    ts: float = 0.0
    seq: int = -1

    def to_payload(self) -> dict[str, Any]:
        return {
            "channel": self.channel,
            "delegate_id": self.delegate_id,
            "op": self.op,
            "phase": self.phase,
            "internal_activity": self.internal_activity,
            "elapsed": self.elapsed,
            "summary": self.summary,
        }

    @classmethod
    def from_payload(cls, payload: dict[str, Any], *, ts: float, seq: int) -> ProgressEvent:
        return cls(
            channel=payload["channel"],
            delegate_id=payload["delegate_id"],
            op=payload["op"],
            phase=payload["phase"],
            internal_activity=payload["internal_activity"],
            elapsed=payload["elapsed"],
            # Pre-R103 traces carry no summary key; replay must keep loading them.
            summary=payload.get("summary"),
            ts=ts,
            seq=seq,
        )


@dataclass(frozen=True, slots=True)
class ObservationEvent:
    """A non-terminal fact emitted by an exactly correlated active delegate."""

    KIND: ClassVar[str] = "observation"

    channel: str
    delegate_id: str
    op: str
    origin_ref: MemoryRef
    trust: Trust
    content: dict[str, Any]
    refs: tuple[MemoryRef, ...] = ()
    ts: float = 0.0
    seq: int = -1

    def __post_init__(self) -> None:
        object.__setattr__(self, "content", json_safe(self.content))

    def to_payload(self) -> dict[str, Any]:
        return {
            "channel": self.channel,
            "delegate_id": self.delegate_id,
            "op": self.op,
            "origin_ref": self.origin_ref,
            "trust": self.trust,
            "content": self.content,
            "refs": list(self.refs),
        }

    @classmethod
    def from_payload(
        cls,
        payload: dict[str, Any],
        *,
        ts: float,
        seq: int,
    ) -> ObservationEvent:
        return cls(
            channel=payload["channel"],
            delegate_id=payload["delegate_id"],
            op=payload["op"],
            origin_ref=payload["origin_ref"],
            trust=payload["trust"],
            content=payload["content"],
            refs=tuple(payload.get("refs", ())),
            ts=ts,
            seq=seq,
        )


@dataclass(frozen=True, slots=True)
class Deadline:
    """A fallback event enqueued with a future ts at dispatch time. No-op if no longer in in_flight (B3)."""

    KIND: ClassVar[str] = "deadline"

    delegate_id: str
    ts: float = 0.0
    seq: int = -1

    def to_payload(self) -> dict[str, Any]:
        return {"delegate_id": self.delegate_id}

    @classmethod
    def from_payload(cls, payload: dict[str, Any], *, ts: float, seq: int) -> Deadline:
        return cls(delegate_id=payload["delegate_id"], ts=ts, seq=seq)


@dataclass(frozen=True, slots=True)
class Compress:
    """A channel's uncompressed entry count reached its compression watermark."""

    KIND: ClassVar[str] = "compress"

    channel: str
    ts: float = 0.0
    seq: int = -1

    def to_payload(self) -> dict[str, Any]:
        return {"channel": self.channel}

    @classmethod
    def from_payload(cls, payload: dict[str, Any], *, ts: float, seq: int) -> Compress:
        return cls(channel=payload["channel"], ts=ts, seq=seq)


@dataclass(frozen=True, slots=True)
class ModelDone:
    """A model call for some slot has finished. The payload only carries the slot name and job_id.

    Model output **doesn't go into the event, and doesn't go into the trace**: it's held by
    the runtime's job table, keyed by job_id. This also fulfills the 04-ports.md hygiene rule
    "the log doesn't persist the raw prompt".
    """

    KIND: ClassVar[str] = "model_done"

    slot: str
    job_id: str
    ts: float = 0.0
    seq: int = -1

    def to_payload(self) -> dict[str, Any]:
        return {"slot": self.slot, "job_id": self.job_id}

    @classmethod
    def from_payload(cls, payload: dict[str, Any], *, ts: float, seq: int) -> ModelDone:
        return cls(slot=payload["slot"], job_id=payload["job_id"], ts=ts, seq=seq)


@dataclass(frozen=True, slots=True)
class CompressDone:
    """A compression call has finished. The summary is likewise held by the job table, not put into the trace."""

    KIND: ClassVar[str] = "compress_done"

    channel: str
    job_id: str
    ts: float = 0.0
    seq: int = -1

    def to_payload(self) -> dict[str, Any]:
        return {"channel": self.channel, "job_id": self.job_id}

    @classmethod
    def from_payload(cls, payload: dict[str, Any], *, ts: float, seq: int) -> CompressDone:
        return cls(channel=payload["channel"], job_id=payload["job_id"], ts=ts, seq=seq)


@dataclass(frozen=True, slots=True)
class SpeakStart:
    """The first token has gone out. Floor switches to agent_speaking — arbitration must finish before this (R5)."""

    KIND: ClassVar[str] = "speak_start"

    utterance_id: str
    priority: int
    ts: float = 0.0
    seq: int = -1

    def to_payload(self) -> dict[str, Any]:
        return {"utterance_id": self.utterance_id, "priority": self.priority}

    @classmethod
    def from_payload(cls, payload: dict[str, Any], *, ts: float, seq: int) -> SpeakStart:
        return cls(
            utterance_id=payload["utterance_id"], priority=payload["priority"], ts=ts, seq=seq
        )


@dataclass(frozen=True, slots=True)
class SpeakEnd:
    KIND: ClassVar[str] = "speak_end"

    utterance_id: str
    ts: float = 0.0
    seq: int = -1

    def to_payload(self) -> dict[str, Any]:
        return {"utterance_id": self.utterance_id}

    @classmethod
    def from_payload(cls, payload: dict[str, Any], *, ts: float, seq: int) -> SpeakEnd:
        return cls(utterance_id=payload["utterance_id"], ts=ts, seq=seq)


@dataclass(frozen=True, slots=True)
class AssistantSpoken:
    """Renderer-acknowledged assistant speech from the realtime path. Carries the
    delivery-truth disposition; suppressed (never audible) output is filtered before
    this event exists, so only speech the user actually heard reaches Memory."""

    KIND: ClassVar[str] = "assistant_spoken"

    text: str
    utterance_id: str
    delivery: Literal["spoken", "interrupted"]
    played_ms: int | None = None
    ts: float = 0.0
    seq: int = -1

    def to_payload(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "utterance_id": self.utterance_id,
            "delivery": self.delivery,
            "played_ms": self.played_ms,
        }

    @classmethod
    def from_payload(cls, payload: dict[str, Any], *, ts: float, seq: int) -> AssistantSpoken:
        return cls(
            text=payload["text"],
            utterance_id=payload["utterance_id"],
            delivery=payload["delivery"],
            played_ms=payload.get("played_ms"),
            ts=ts,
            seq=seq,
        )


Event = (
    UserInput
    | HandoffEvent
    | ProgressEvent
    | ObservationEvent
    | Deadline
    | Compress
    | ModelDone
    | CompressDone
    | SpeakStart
    | SpeakEnd
    | AssistantSpoken
)

# Explicit registry, no reflection. Changing the event table = changing this line.
EVENT_TYPES: tuple[type[Event], ...] = (
    UserInput,
    HandoffEvent,
    ProgressEvent,
    ObservationEvent,
    Deadline,
    Compress,
    ModelDone,
    CompressDone,
    SpeakStart,
    SpeakEnd,
    AssistantSpoken,
)


@dataclass(frozen=True, slots=True)
class WakeReason:
    """The reason for a wake-up, carrying a priority — not a boolean flag.

    A boolean flag isn't enough: speak priority is decided by the **triggering event**
    (01-spine.md's Floor section), and if the triggering reason is dropped, a pending
    re-run wouldn't know which priority to use (R1).

    `selected_suggestion` is the payload the second hop of the two-hop speak-up carries
    (R39). It's attached **here** rather than as a scalar on the runtime: waking goes
    through a `higher()` merge, and a global scalar would have nothing to do with whichever
    reason wins the merge — so "the one the agent picked" could get silently swept away by
    some more urgent wake-up that fires instead, the user hears not a word about it, yet
    that suggestion is locked out for a whole cooldown period regardless. Attaching it to
    the reason means that when this wake-up loses the merge, its choice is discarded right
    along with it, and the suggestion stays in the pool, still `pending`.
    """

    kind: str  # the kind of the event that triggered it
    priority: int  # the bigger, the more urgent; bound by the runtime per event, the model can't self-elevate it
    routing_class: RoutingClass = "ambient"  # inherited along the causal chain (R12)
    origin: str | None = None  # causal attribution: points to the memory entry that triggered it
    selected_suggestion: str | None = None  # the suggestion the agent picked for this wake-up (R39)


def kind_rank(event: Event) -> int:
    """The second dimension for same-instant ordering. Only two values — narrowed down from a three-value version; see the module docstring and R16."""
    return 1 if event.KIND == Deadline.KIND else 0


class EventQueue:
    """Deterministic event queue. Single-threaded, reproducible dequeue order."""

    def __init__(self) -> None:
        self._heap: list[tuple[float, int, int, Event]] = []
        self._seq = 0

    def push(self, event: Event, *, at: float) -> Event:
        """Stamp (ts, seq) and enqueue, returning the stamped copy."""
        self._seq += 1
        stamped = replace(event, ts=at, seq=self._seq)
        heapq.heappush(self._heap, (at, kind_rank(stamped), self._seq, stamped))
        return stamped

    def pop_ready(self, now: float) -> Event | None:
        """Pop one event that's due; None if there isn't one (future events stay in the queue)."""
        if not self._heap or self._heap[0][0] > now:
            return None
        return heapq.heappop(self._heap)[3]

    def next_ts(self) -> float | None:
        """The earliest event time in the queue; None for an empty queue."""
        return self._heap[0][0] if self._heap else None

    def __len__(self) -> int:
        return len(self._heap)
