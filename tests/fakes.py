"""The three scripted model ports: the "model" source among the four deterministic sources
(06-verification.md).

Lives in tests/, not src/: only tests use it, and Phase C swaps it directly for the real gateway.
Like the two simulators, **the only suspend point is clock.sleep()** — this file is also in
scope for the wall-clock hygiene scan.

The speak axis emits in the order the spike measured in practice: **text finishes streaming
first → the act axis arrives after** (04-ports.md Q2/Q3). So what "speak-while-dispatching"
needs to preserve on the harness side isn't interleaving, it's **no buffering**: forward a
chunk of text the moment it's received. The fake emits in multiple chunks specifically so a
degenerate "buffer the whole stream" implementation would show up.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterable, Sequence

from nova_audio_agent.calls import NO_ACTION, CallRecord
from nova_audio_agent.clock import Clock
from nova_audio_agent.context_view import ContextView, compile_context_view
from nova_audio_agent.events import WakeReason
from nova_audio_agent.memory import Memory, MemoryItem
from nova_audio_agent.ports import (
    ActionDelta,
    ActionOutput,
    FastBrainDelta,
    FastBrainOutput,
    SpeakActDelta,
    SpeakOutput,
    SurrogateOutput,
    TextDelta,
)

SILENT = FastBrainOutput(speak=SpeakOutput(act="none"), action=ActionOutput(act="none"))


def finished_call(
    *,
    text: str = "",
    action: ActionOutput = NO_ACTION,
    utterance_id: str = "u-0",
) -> CallRecord:
    """An "already finished" fast-call product, for test cases that only care about the event flow.

    `model_done` stops being a no-op starting at B1: it has to fetch a CallRecord from the job
    table. A test that fakes the product with a plain string will blow up inside apply —
    **that's correct**: the real path can never produce that kind of model_done (`wake()` only
    recognizes slots wired to a real port, and `_spawn_slot` only ever produces a CallRecord).
    So what's returned here is the minimal **legal** product, not a bypass that lets the runtime
    tolerate an illegal one.
    """
    return CallRecord(
        slot="fast",
        reason=WakeReason(kind="user_input", priority=100, routing_class="user_awaited"),
        view=compile_context_view(Memory(), floor="idle", now=0.0),
        utterance_id=utterance_id,
        spoken_text=text,
        action=action,
    )


class ScriptedFastBrain:
    """Returns the preset two-axis outputs in call order; once the script runs out it goes
    silent every time ((none, none))."""

    def __init__(
        self,
        outputs: Sequence[FastBrainOutput] = (),
        *,
        clock: Clock,
        latency: float = 0.1,
        chunk_size: int = 6,
    ) -> None:
        self._outputs = list(outputs)
        self._clock = clock
        self._latency = latency
        self._chunk_size = chunk_size
        self.views: list[
            ContextView
        ] = []  # the ContextView seen on each call, for snapshot assertions
        # the virtual instant each chunk of text **leaves the model**. This is the control group
        # for scenario 2's assertion: the times recorded at the sink must match these chunk-for-
        # chunk; an implementation that buffers the whole stream won't line up (R24).
        self.emitted: list[tuple[float, str]] = []

    async def call(self, view: ContextView) -> AsyncIterator[FastBrainDelta]:
        self.views.append(view)
        output = self._outputs.pop(0) if self._outputs else SILENT

        for chunk in _chunks(output.speak.text, self._chunk_size):
            await self._clock.sleep(self._latency)
            self.emitted.append((self._clock.now(), chunk))
            yield TextDelta(text=chunk)

        # only `ask` gets marked: unmarked defaults to `say` (R29). This asymmetry mirrors the
        # real adapter — a question has downstream consequences, a statement doesn't need the
        # model to say anything extra.
        if output.speak.act == "ask":
            yield SpeakActDelta(act="ask")

        if output.action.act != "none":
            await self._clock.sleep(self._latency)
            yield ActionDelta(action=output.action)


class ScriptedSurrogate:
    """Returns the preset judgments for watch in order; once the script runs out it never speaks."""

    def __init__(
        self,
        decisions: Sequence[SurrogateOutput] = (),
        *,
        clock: Clock,
        latency: float = 0.05,
    ) -> None:
        self._decisions = list(decisions)
        self._clock = clock
        self._latency = latency
        self.watched: list[ContextView] = []

    async def watch(self, view: ContextView) -> SurrogateOutput:
        self.watched.append(view)
        await self._clock.sleep(self._latency)
        if self._decisions:
            return self._decisions.pop(0)
        return SurrogateOutput(speak=False, reason="脚本用完了")


class ScriptedCompressor:
    """Returns a recognizable summary string, and records each batch of items it receives."""

    def __init__(self, *, clock: Clock, latency: float = 0.05) -> None:
        self._clock = clock
        self._latency = latency
        self.compressed: list[tuple[MemoryItem, ...]] = []

    async def compress(self, items: Sequence[MemoryItem]) -> str:
        self.compressed.append(tuple(items))
        await self._clock.sleep(self._latency)
        return f"摘要：{len(items)} 条"


def _chunks(text: str | None, size: int) -> Iterable[str]:
    if not text:
        return ()
    return (text[start : start + size] for start in range(0, len(text), size))
