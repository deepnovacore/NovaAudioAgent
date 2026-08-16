from __future__ import annotations

import pytest

from nova_audio_agent.memory import CONVERSATION_CHANNEL, MemoryItem
from nova_audio_agent.realtime.history import (
    MAX_PACKED_RECOVERY_CONTENT,
    RecoveryTurn,
    pack_recovery_turns,
    project_recovery_turns,
)


def item(
    seq: int,
    text: str,
    *,
    trust: str,
    channel: str = CONVERSATION_CHANNEL,
    outcome: str | None = None,
    delivery: str | None = None,
    played_ms: int | None = None,
) -> MemoryItem:
    content: dict[str, object] = {"text": text}
    if delivery is not None:
        content["delivery"] = delivery
        content["played_ms"] = played_ms
    return MemoryItem(
        channel=channel,
        seq=seq,
        ts=float(seq),
        trust=trust,  # type: ignore[arg-type]
        priority=50,
        content=content,
        outcome=outcome,  # type: ignore[arg-type]
    )


def user(seq: int, text: str, **kwargs: object) -> MemoryItem:
    return item(seq, text, trust="trusted_user", **kwargs)  # type: ignore[arg-type]


def assistant(
    seq: int,
    text: str,
    *,
    delivery: str = "spoken",
    played_ms: int | None = 100,
    **kwargs: object,
) -> MemoryItem:
    return item(
        seq,
        text,
        trust="trusted_system",
        delivery=delivery,
        played_ms=played_ms,
        **kwargs,  # type: ignore[arg-type]
    )


def test_projection_pairs_only_complete_turns_in_chronological_order() -> None:
    items = (
        assistant(1, "leading"),
        user(2, "old unmatched"),
        user(3, "first question"),
        assistant(4, "first answer", played_ms=240),
        assistant(5, "repeated assistant"),
        user(6, "second question"),
        assistant(7, "second answer", played_ms=None),
        user(8, "trailing unmatched"),
    )

    assert project_recovery_turns(items, max_pairs=4) == (
        RecoveryTurn(
            sequence=3,
            role="user",
            text="first question",
            delivery="user_final",
            played_ms=None,
            trust="trusted_user",
            source="conversation",
        ),
        RecoveryTurn(
            sequence=4,
            role="assistant",
            text="first answer",
            delivery="spoken",
            played_ms=240,
            trust="trusted_system",
            source="conversation",
        ),
        RecoveryTurn(
            sequence=6,
            role="user",
            text="second question",
            delivery="user_final",
            played_ms=None,
            trust="trusted_user",
            source="conversation",
        ),
        RecoveryTurn(
            sequence=7,
            role="assistant",
            text="second answer",
            delivery="spoken",
            played_ms=None,
            trust="trusted_system",
            source="conversation",
        ),
    )


def test_projection_selects_newest_whole_pair_budgets() -> None:
    items = tuple(
        turn
        for pair in range(1, 5)
        for turn in (
            user(pair * 2 - 1, f"q{pair}"),
            assistant(pair * 2, f"a{pair}"),
        )
    )

    for max_pairs, expected_sequences in (
        (1, (7, 8)),
        (2, (5, 6, 7, 8)),
        (4, (1, 2, 3, 4, 5, 6, 7, 8)),
    ):
        projected = project_recovery_turns(items, max_pairs=max_pairs)
        assert tuple(turn.sequence for turn in projected) == expected_sequences


def test_character_budget_drops_oldest_complete_pairs_without_truncating() -> None:
    items = (
        user(1, "1234"),
        assistant(2, "5678"),
        user(3, "abc"),
        assistant(4, "def"),
    )

    projected = project_recovery_turns(items, max_pairs=2, max_chars=7)

    assert tuple(turn.sequence for turn in projected) == (3, 4)
    assert tuple(turn.text for turn in projected) == ("abc", "def")
    assert project_recovery_turns(items, max_pairs=2, max_chars=5) == ()


def test_packed_projection_drops_oldest_whole_pairs_after_json_escaping() -> None:
    turns = tuple(
        turn
        for pair in range(1, 5)
        for turn in (
            RecoveryTurn(
                sequence=pair * 2 - 1,
                role="user",
                text=('\\"' * 300) + f"q{pair}",
                delivery="user_final",
                played_ms=None,
                trust="trusted_user",
            ),
            RecoveryTurn(
                sequence=pair * 2,
                role="assistant",
                text=('\\"' * 300) + f"a{pair}",
                delivery="spoken",
                played_ms=100,
                trust="trusted_system",
            ),
        )
    )

    fitted, content = pack_recovery_turns(turns)

    assert 0 < len(content) <= MAX_PACKED_RECOVERY_CONTENT
    assert len(fitted) % 2 == 0
    assert tuple(turn.sequence for turn in fitted) == tuple(range(9 - len(fitted), 9))


def test_projection_excludes_noncanonical_memory_items() -> None:
    items = (
        user(1, "wrong channel", channel="codex"),
        assistant(2, "wrong channel answer", channel="codex"),
        user(3, "has outcome", outcome="ok"),
        assistant(4, "answer to outcome", outcome="ok"),
        item(5, "untrusted user", trust="untrusted_external"),
        assistant(6, "answer to untrusted"),
        user(7, "wrong assistant trust question"),
        item(8, "wrong trust answer", trust="trusted_user", delivery="spoken"),
        user(9, "interrupted question"),
        assistant(10, "interrupted answer", delivery="interrupted"),
        user(11, "empty assistant question"),
        assistant(12, ""),
        user(13, "must not bind after interruption"),
        assistant(14, "interrupted", delivery="interrupted"),
        assistant(15, "later unrelated spoken answer"),
        user(16, "kept question"),
        assistant(17, "kept answer", played_ms=321),
    )

    projected = project_recovery_turns(items, max_pairs=4)

    assert tuple((turn.sequence, turn.text) for turn in projected) == (
        (16, "kept question"),
        (17, "kept answer"),
    )


def test_projection_rejects_nonpositive_pair_budget() -> None:
    assert project_recovery_turns((user(1, "q"), assistant(2, "a")), max_pairs=0) == ()


def test_recovery_turn_constructor_rejects_noncanonical_trust_and_delivery() -> None:
    with pytest.raises(ValueError, match="canonical user"):
        RecoveryTurn(
            sequence=1,
            role="user",
            text="old command",
            delivery="user_final",
            played_ms=None,
            trust="untrusted_external",
        )
    with pytest.raises(ValueError, match="canonical assistant"):
        RecoveryTurn(
            sequence=2,
            role="assistant",
            text="partial answer",
            delivery="spoken",
            played_ms=10,
            trust="untrusted_external",
        )
