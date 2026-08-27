"""Channels' append-only property and MemoryRef's canonical form (Phase A green-light item: A2-1).

append-only is half of D14 "JSONL is the trace" in memory: losing an observation
means it can't be replayed, so the "existing prefix unchanged" assertion needs
a positive twin — **the new item actually got in** — otherwise an implementation
that drops writes (append does nothing) would still satisfy "prefix unchanged".
"""

from __future__ import annotations

import pytest

from nova_audio_agent.memory import (
    CONVERSATION_CHANNEL,
    Channel,
    ConversationScope,
    Memory,
    make_ref,
    parse_ref,
)
from policies import SLOW_SIM_POLICY


def _memory() -> Memory:
    return Memory(policies=(SLOW_SIM_POLICY,))


def test_append_keeps_the_existing_prefix_and_adds_exactly_one() -> None:
    channel = Channel(name="slow_sim")
    first = channel.append(ts=1.0, trust="trusted_system", priority=50, content={"n": 1})
    before = channel.items

    second = channel.append(ts=2.0, trust="trusted_system", priority=50, content={"n": 2})

    assert channel.items[: len(before)] == before  # existing prefix unchanged item-by-item
    assert len(channel.items) == len(before) + 1  # positive twin: exactly +1
    assert channel.items[-1] is second  # and the last item is the new one
    assert first.seq == 1 and second.seq == 2  # monotonic within the channel


def test_append_counts_uncompressed_for_the_watermark() -> None:
    channel = Channel(name="slow_sim")
    assert channel.uncompressed == 0

    channel.append(ts=1.0, trust="trusted_system", priority=50, content={})
    channel.append(ts=2.0, trust="trusted_system", priority=50, content={})

    assert channel.uncompressed == 2  # the watermark's counting source (writer lands in Phase C)
    assert channel.summary is None  # the summary's writer is also in Phase C


def test_memory_ref_is_channel_and_seq() -> None:
    """05-executors.md requires origin_ref to be "resolvable → points at a real MemoryItem".

    MemoryItem's natural primary key is (channel, seq), so the canonical form is pinned here.
    The three checks (resolvable / same scope / appeared in this call's ContextView) land in B1.
    """
    channel = Channel(name="conversation")
    item = channel.append(ts=0.0, trust="trusted_user", priority=100, content={"text": "hi"})

    assert item.ref == "conversation:1"
    assert make_ref("conversation", 1) == item.ref
    assert parse_ref(item.ref) == ("conversation", 1)

    with pytest.raises(ValueError):
        parse_ref("没有冒号")


def test_memory_opens_one_channel_per_policy_plus_conversation() -> None:
    """Channel count = conversation channel + loaded executors. The sole authority for policies is the manifest; this is just a lookup table."""
    memory = _memory()

    assert set(memory.channels) == {CONVERSATION_CHANNEL, "slow_sim"}
    assert memory.policies["slow_sim"] is SLOW_SIM_POLICY
    assert (
        memory.policies[CONVERSATION_CHANNEL].wake == "none"
    )  # the conversation channel has no handoff
    assert (
        memory.policies[CONVERSATION_CHANNEL].compress_watermark > 0
    )  # but it does have a watermark


def test_memory_append_routes_to_the_named_channel() -> None:
    memory = _memory()

    item = memory.append(
        "slow_sim",
        ts=3.0,
        trust="trusted_system",
        priority=50,
        content={"brightness": 30},
        outcome="ok",
        refs=("conversation:1",),
    )

    assert memory.channels["slow_sim"].items == (item,)
    assert memory.channels[CONVERSATION_CHANNEL].items == ()
    assert item.outcome == "ok"
    assert item.refs == ("conversation:1",)


def test_refused_is_preserved_as_a_distinct_terminal_outcome() -> None:
    memory = _memory()

    item = memory.append(
        "slow_sim",
        ts=3.0,
        trust="trusted_system",
        priority=50,
        content={"code": "needs_selection"},
        outcome="refused",
        refs=("conversation:1",),
    )

    assert item.outcome == "refused"


def test_memory_append_rejects_an_unknown_channel() -> None:
    """Only one executor loads at a time: writing to a channel that was never opened is a bug, not something to silently tolerate."""
    memory = _memory()

    with pytest.raises(KeyError):
        memory.append("ha", ts=0.0, trust="trusted_system", priority=1, content={})


def test_scope_key_never_carries_the_session_id() -> None:
    """08-deferred.md's extremely thin implementation: this is the only rule kept."""
    scope = ConversationScope()

    assert "session" not in repr(scope)
    assert not hasattr(scope, "session_id")
