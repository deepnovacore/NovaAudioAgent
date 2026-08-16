"""Floor: arbitrates who has the right to speak (01-spine.md).

Three states + one priority comparison. The contract is settled, the implementation
deliberately thin — when ASR/TTS are wired in, only the implementation changes, not
the structure: speak_start / speak_end's source switches from CLI to TTS, and
user_speaking's source switches from "nothing" to VAD.

**Priority is decided by the triggering event, not handed down by the model.** That
binding table isn't repeated here — it's runtime.wake_targets: user_input is fixed
at USER_PRIORITY, handoff takes HandoffPolicy.priority, deadline inherits the
priority of the channel the original delegate belonged to. Floor only consumes an
already-bound WakeReason.priority. There is only one source for any given fact.

**Where a defer lands is the suggestion pool** (not dropped, not queued), and that
pool is scheduled for B2. So in stage A, Floor is a pure decision function: it only
gives a verdict, it doesn't manage where things land.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

FloorState = Literal["idle", "user_speaking", "agent_speaking"]
FloorDecision = Literal["allow", "preempt", "defer"]


@dataclass(frozen=True, slots=True)
class Floor:
    state: FloorState = "idle"
    utterance_id: str | None = None
    priority: int | None = None  # priority of the current utterance, only set when agent_speaking
    user_speech_id: str | None = None

    def decide(self, priority: int) -> FloorDecision:
        """Arbitrate one speak request. **Must be decided before the first token**
        (R5) — arbitrating after sound has already come out is meaningless."""
        if self.state == "idle":
            return "allow"
        if self.state == "user_speaking":
            # This round is implemented as always defer. On the text CLI this window is very short.
            # Full barge-in and "AI interrupts user" are two separate deferred items, see 08-deferred.md.
            return "defer"
        return "preempt" if priority > (self.priority or 0) else "defer"

    def on_speak_start(self, utterance_id: str, priority: int) -> Floor:
        return Floor(state="agent_speaking", utterance_id=utterance_id, priority=priority)

    def on_user_speak_start(self, speech_id: str) -> Floor:
        return Floor(state="user_speaking", user_speech_id=speech_id)

    def on_user_speak_end(self, speech_id: str) -> Floor:
        if self.state != "user_speaking" or speech_id != self.user_speech_id:
            return self
        return Floor()

    def on_speak_end(self, utterance_id: str) -> Floor:
        """Only the current utterance's speak_end releases the floor: a late end for
        an utterance that was already preempted doesn't count."""
        if self.state == "user_speaking":
            return self
        if self.state == "agent_speaking" and utterance_id != self.utterance_id:
            return self
        return Floor()
