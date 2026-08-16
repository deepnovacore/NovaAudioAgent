"""HandoffPolicy: one per executor, with explicit suggestion admission (02-memory.md).

The manuscript's requirement that "different executors have different priorities and different
frequencies" lands on the original five fields. `suggest` is the explicit executor-to-pool entrance.
When real executors are wired in, this is where the real values go. The sole authority is
ExecutorManifest.policy (10-executor-onboarding.md); Memory.policies is just a lookup table keyed by
channel name — **but the runtime reads from this table**, so the two copies of the value must stay equal,
checked by runtime._check_executor_wiring at assembly time (R51). It used to be just a convention, held
together by fixtures sharing the same set of constants (added per codex review).

**`min_interval` remains removed (R43).** What it wanted to throttle was
waking, not writing, and this round that job is fully covered by single-flight pending merging: while a
call is in flight, multiple wakes are merged into one taking the higher value; when nothing is in flight,
spawn happens immediately every time. To actually honor "at least N seconds between two wakes" during idle
periods too would require scheduling a retry timer that was never declared — the same reason R2 killed
`merge: latest`. Keeping a field that no reader in the whole project reads is the same as writing "someone's
already handling it" for something that isn't done yet.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

WakeTarget = Literal["fast", "surrogate", "none"]

# One channel holds both sides: what the user said and what the AI itself said, distinguished by trust
# (R22). Splitting into two channels would misalign the **per-channel** RECENT_LIMIT window — a question
# and its answer would get truncated at different depths, and the reassembled conversation would be
# missing half; and not storing what the AI said would make FastBrain repeat itself, and the suggestion
# pool's cooldown would lose half its basis.
CONVERSATION_CHANNEL = "conversation"
# user_input's speaking priority is fixed at the highest (01-spine.md, the Floor section).
# It's an **event** priority, not a channel name, so it doesn't change when the channel name changes.
# The constant lives here rather than in floor.py so that "channel policy" has a single source.
USER_PRIORITY = 100


@dataclass(frozen=True, slots=True)
class HandoffPolicy:
    channel: str
    priority: int  # higher is more urgent
    wake: WakeTarget
    typical_latency: float  # used by ContextView to compute eta
    compress_watermark: int  # threshold count of uncompressed items
    suggest: bool = False
    progress_via_surrogate: bool = False


# The conversation channel has no handoff (wake=none), but compression operates per channel, so it needs
# a policy too.
CONVERSATION_CHANNEL_POLICY = HandoffPolicy(
    channel=CONVERSATION_CHANNEL,
    priority=USER_PRIORITY,
    wake="none",
    typical_latency=0.0,
    compress_watermark=40,
)
