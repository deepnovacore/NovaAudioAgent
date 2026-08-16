"""Pure canonical conversation projection for bounded realtime recovery experiments."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Literal, Sequence

from nova_audio_agent.memory import CONVERSATION_CHANNEL, MemoryItem, Trust

MAX_PACKED_RECOVERY_CONTENT = 3900


@dataclass(frozen=True, slots=True)
class RecoveryTurn:
    sequence: int
    role: Literal["user", "assistant"]
    text: str
    delivery: Literal["user_final", "spoken"]
    played_ms: int | None
    trust: Trust
    source: Literal["conversation"] = "conversation"

    def __post_init__(self) -> None:
        if type(self.sequence) is not int or self.sequence < 1:
            raise ValueError("recovery sequence must be positive")
        if type(self.text) is not str or not self.text.strip():
            raise ValueError("recovery text must be non-empty")
        if self.source != "conversation":
            raise ValueError("recovery source must be conversation")
        if self.role == "user":
            if (
                self.delivery != "user_final"
                or self.trust != "trusted_user"
                or self.played_ms is not None
            ):
                raise ValueError("invalid canonical user recovery turn")
        elif self.role == "assistant":
            if self.delivery != "spoken" or self.trust != "trusted_system":
                raise ValueError("invalid canonical assistant recovery turn")
            if self.played_ms is not None and (
                type(self.played_ms) is not int or self.played_ms < 0
            ):
                raise ValueError("played_ms must be non-negative")
        else:
            raise ValueError("unknown recovery role")


def project_recovery_turns(
    items: Sequence[MemoryItem],
    *,
    max_pairs: int,
    max_chars: int = 3500,
) -> tuple[RecoveryTurn, ...]:
    """Return the newest whole trusted user/spoken-assistant pairs within both bounds."""
    if max_pairs <= 0 or max_chars <= 0:
        return ()
    pairs: list[tuple[RecoveryTurn, RecoveryTurn]] = []
    pending_user: RecoveryTurn | None = None
    for item in items:
        if item.channel != CONVERSATION_CHANNEL or item.outcome is not None:
            continue
        text = item.content.get("text")
        if type(text) is not str or not text.strip():
            continue
        if item.trust == "trusted_user" and "delivery" not in item.content:
            pending_user = RecoveryTurn(
                sequence=item.seq,
                role="user",
                text=text,
                delivery="user_final",
                played_ms=None,
                trust="trusted_user",
            )
            continue
        if (
            pending_user is None
            or item.trust != "trusted_system"
            or item.content.get("delivery") != "spoken"
        ):
            if pending_user is not None and item.trust == "trusted_system":
                pending_user = None
            continue
        played_ms = item.content.get("played_ms")
        if type(played_ms) is not int:
            played_ms = None
        pairs.append(
            (
                pending_user,
                RecoveryTurn(
                    sequence=item.seq,
                    role="assistant",
                    text=text,
                    delivery="spoken",
                    played_ms=played_ms,
                    trust="trusted_system",
                ),
            )
        )
        pending_user = None

    selected = pairs[-max_pairs:]
    while selected and sum(len(turn.text) for pair in selected for turn in pair) > max_chars:
        selected.pop(0)
    return tuple(turn for pair in selected for turn in pair)


def pack_recovery_turns(
    history: Sequence[RecoveryTurn],
    *,
    max_chars: int = MAX_PACKED_RECOVERY_CONTENT,
) -> tuple[tuple[RecoveryTurn, ...], str]:
    """Encode newest whole pairs without ever slicing encoded JSON."""
    turns = list(history)
    while turns:
        content = json.dumps(
            {
                "version": 1,
                "turns": [
                    {"sequence": turn.sequence, "role": turn.role, "text": turn.text}
                    for turn in turns
                ],
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        if len(content) <= max_chars:
            return tuple(turns), content
        del turns[:2]
    return (), ""
