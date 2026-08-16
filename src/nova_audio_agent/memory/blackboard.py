"""Blackboard: an aggregate of three content categories (02-memory.md).

| Category | Write pattern | Reader | Lifecycle |
|---|---|---|---|
| Channels | append-only | ContextView (summarized) | Long, converges via compression |
| Structured State | field-level overwrite (R37), sole writer is FastBrain | ContextView (in full) | Lives as long as the conversation |
| Suggestion Pool | add/remove/modify state machine | ContextView + Surrogate | Short, converges via cooldown and expiry |

**The suggestion pool is not in Phase A**: 09-roadmap.md schedules it for B2 (building the structure and
populating the pool) and B4 (cooldown/rearm/expiry).

The blackboard is keyed by ConversationScope; this round there is only one scope, so the implementation is
extremely thin. The one rule that's kept: **session_id never enters the matching key** — it's only a
transport identifier.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from nova_audio_agent.memory.items import Channel, MemoryItem, MemoryRef, Outcome, Trust
from nova_audio_agent.memory.policy import CONVERSATION_CHANNEL_POLICY, HandoffPolicy
from nova_audio_agent.memory.structured import StructuredState


@dataclass(frozen=True, slots=True)
class ConversationScope:
    """Matching key. The shape of the three-way projection (IdentityScope / ConversationScope /
    TransportContext) is written into the contract; the implementation this round is extremely thin —
    only one scope. See 08-deferred.md for trigger conditions.
    """

    conversation_id: str = "default"


class Memory:
    """A blackboard.

    Channel count = conversation + always-on readonly executors + exactly one active
    non-readonly executor.
    """

    def __init__(
        self,
        *,
        scope: ConversationScope | None = None,
        policies: Sequence[HandoffPolicy] = (),
    ) -> None:
        self.scope = scope or ConversationScope()
        self.structured = StructuredState()
        self.policies: dict[str, HandoffPolicy] = {
            CONVERSATION_CHANNEL_POLICY.channel: CONVERSATION_CHANNEL_POLICY
        }
        for policy in policies:
            self.policies[policy.channel] = policy
        self.channels: dict[str, Channel] = {name: Channel(name=name) for name in self.policies}

    def append(
        self,
        channel: str,
        *,
        ts: float,
        trust: Trust,
        priority: int,
        content: dict[str, Any],
        outcome: Outcome | None = None,
        refs: tuple[MemoryRef, ...] = (),
    ) -> MemoryItem:
        """Append to a channel that's already open. A nonexistent channel is a bug, not something to
        silently tolerate."""
        return self.channels[channel].append(
            ts=ts,
            trust=trust,
            priority=priority,
            content=content,
            outcome=outcome,
            refs=refs,
        )
