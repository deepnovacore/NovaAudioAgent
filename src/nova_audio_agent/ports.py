"""Signatures for the four Protocols and every spec type: the three model ports FastBrain / Surrogate / Compressor
(04-ports.md) + the executor port ExecutorAdapter (05-executors.md).
The ModelGateway from doc 04 is the provider boundary shared by the three model ports;
it remains outside this contract-only module.

Ports are **contracts**, not subsystems. The real gateway and schema compiler depend
on these signatures, not the other way around.

## Two orthogonal axes, all nine combinations legal

SpeakAct x ActAct. "Dim the living-room light for me, and, by the way, what's good to watch
tonight?" — under a single enum this sentence could only pick one of the two, or stuff the
other thing into the payload by convention, and that's a heuristic leaking back in (D5).
Splitting into two axes means no illegal-combination validation table is needed. (none, none)
is just silent, as in the design doc.

## The speak axis is an incremental stream

`FastBrain.call()` returns an incremental stream rather than taking a sink callback: this way,
"speak_start happens before delegate dispatch" becomes an observable property of the runtime
(**whether the harness buffers**, the landing spot for R8a), rather than a discipline enforced
inside the port implementation. Forward text deltas the moment they arrive; don't wait for the
stream to finish.

Spike testing (04-ports.md): the real provider's arrival order is invariably "all the text is
emitted -> then tool_calls", with zero interleaving. So the only thing the harness side needs
to guarantee is not buffering.

## Fields the model can't touch are built into the type (R17)

All six of DelegateSpec's fields are present, just split across two types:
- `DelegateRequest`: the four the model fills in (executor / op / request / origin_ref)
- `Delegate`: the shape after runtime binding (+ delegate_id / deadline / routing_class / dispatched_at)

So "the model can't touch deadline and routing_class" goes from a review discipline to
**something the type system can't even express**. The only construction entry point is bind_delegate().
"""

from __future__ import annotations

import unicodedata
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from nova_audio_agent.clock import Clock
from nova_audio_agent.context_view import ContextView
from nova_audio_agent.events import RoutingClass, WakeReason
from nova_audio_agent.memory import HandoffPolicy, MemoryItem, MemoryRef, Outcome, Trust

SpeakAct = Literal["none", "say", "ask"]
ActAct = Literal["none", "delegate", "update"]


# ---- Action axis ----


@dataclass(frozen=True, slots=True)
class DelegateRequest:
    """The four fields the model fills in. **No deadline here, and no routing_class**—

    letting the model fill in deadline would be equivalent to silently switching off the
    "once a task is dispatched, there's always a follow-up" guarantee (R9); letting the
    model control routing_class would let it downgrade a result the user is waiting for
    into a suggestion sitting unseen in the pool (R12).
    """

    executor: str
    op: str
    request: dict[str, Any]
    origin_ref: MemoryRef  # causal attribution: which task is this delegate answering, and for what


@dataclass(frozen=True, slots=True)
class Delegate:
    """The shape after runtime binding. The only construction entry point is bind_delegate()."""

    delegate_id: str
    executor: str
    op: str
    request: dict[str, Any]
    origin_ref: MemoryRef
    deadline: float  # bound by the runtime from OpSpec.deadline_budget
    routing_class: RoutingClass  # inherited by the runtime along the causal chain
    dispatched_at: float


@dataclass(frozen=True, slots=True)
class UpdateSpec:
    target: Literal["intent", "goal", "authorization"]
    delta: dict[str, Any]


# ---- FastBrain output ----


@dataclass(frozen=True, slots=True)
class SpeakOutput:
    act: SpeakAct
    text: str | None = None


@dataclass(frozen=True, slots=True)
class ActionOutput:
    act: ActAct
    delegate: DelegateRequest | None = None
    update: UpdateSpec | None = None


@dataclass(frozen=True, slots=True)
class FastBrainOutput:
    speak: SpeakOutput
    action: ActionOutput


@dataclass(frozen=True, slots=True)
class TextDelta:
    """One chunk of the speak axis's incremental stream. Forward it the moment it arrives; don't buffer."""

    text: str


@dataclass(frozen=True, slots=True)
class SpeakActDelta:
    """Whether this utterance is a statement or a question. **Arrives after the text**, because it belongs to the structured half (R29).

    The text itself has already streamed by; only act is carried here. Without this delta,
    it's `say` by default — only `ask` needs an explicit marker, because only it has a
    downstream consequence: when Floor defers it, the `kind` that goes into the pool is
    `question` rather than `notify` (the first of the three entry points in 02-memory.md).

    Why not attach act to `TextDelta`: the moment the first chunk of text is in hand, a real
    adapter still doesn't know whether this is a question — it has to wait for the model to
    finish emitting the structured half. Why not attach it to `ActionDelta`: the cell
    `(ask, none)` produces no action-axis output at all, so the information would still be lost.
    """

    act: SpeakAct


@dataclass(frozen=True, slots=True)
class ActionDelta:
    """One structured output on the action axis (native tool_calls)."""

    action: ActionOutput


@dataclass(frozen=True, slots=True)
class ContractFailureDelta:
    """Malformed model-side structure, without retaining its raw payload."""

    code: str
    tool_name: str | None = None


FastBrainDelta = TextDelta | SpeakActDelta | ActionDelta | ContractFailureDelta


@dataclass(frozen=True, slots=True)
class SurrogateOutput:
    """Surrogate **doesn't generate speech**. It only decides whether to speak up, and which item from the pool (the single-persona invariant)."""

    speak: bool
    suggestion_id: str | None = None
    reason: str = ""


# ---- Executors ----


@dataclass(frozen=True, slots=True)
class OpSpec:
    """One executor operation compiled to one provider tool (D20)."""

    name: str
    description: str
    params: dict[str, Any]  # JSON Schema
    readonly: bool = False
    confirm: bool = False
    deadline_budget: float = 30.0
    # Only meaningful for readonly ops: which ops' results this probe can **settle**.
    # Defaults to empty = its return is just a new piece of evidence, not enough to rewrite an unknown into a verdict (R13).
    verifies: tuple[str, ...] = ()
    # Top-level request fields that must not be copied into durable deadline
    # evidence. The executor still receives the original request.
    sensitive_params: tuple[str, ...] = ()
    # R105: fast readonly ops opt into a real synchronous tool result instead of a
    # delegation acknowledgement. An explicit manifest flag, never derived from
    # readonly or typical_latency.
    sync_result: bool = False

    def __post_init__(self) -> None:
        if self.sync_result and not self.readonly:
            raise ValueError("sync_result 仅允许用于 readonly 操作")
        if type(self.sensitive_params) is not tuple:
            raise ValueError("sensitive_params 必须是 tuple")
        properties = self.params.get("properties")
        seen: set[str] = set()
        for name in self.sensitive_params:
            if (
                type(name) is not str
                or name in seen
                or not isinstance(properties, dict)
                or name not in properties
            ):
                raise ValueError("sensitive_params 每项必须是 params.properties 中唯一的精确字符串")
            seen.add(name)


@dataclass(frozen=True, slots=True)
class ExecutorManifest:
    name: str
    ops: tuple[OpSpec, ...]
    policy: HandoffPolicy
    confirm_ttl: float = 0.0

    def op(self, name: str) -> OpSpec | None:
        return next((spec for spec in self.ops if spec.name == name), None)


@dataclass(frozen=True, slots=True)
class Handoff:
    """An executor's return: **it only reports the outcome, it doesn't say who it is** (R46).

    The identity fields — `delegate_id` / `channel` / `origin_ref`, and ts / seq which
    were never here to begin with — are all bound by the runtime from the dispatch record,
    so this type doesn't have any of them at all. This is the same move on the executor
    side as the `DelegateRequest -> Delegate` split: fields the model/adapter can't touch
    are built into the type, not left to discipline (R17).

    Originally these three were filled in by the adapter. That meant a handoff with
    `delegate_id="d-999"` could attach its result to any arbitrary delegate, and a
    nonexistent `channel` could make `memory.policies[...]` raise a bare KeyError and kill
    the whole loop. Neither is a "bad output" — it's a **bad identity**: a bad output is
    just an observation, whereas a bad identity doesn't even qualify to become one.

    `trust` stayed, because it's genuinely something only the adapter knows: a page search
    fetches back is `untrusted_external`, a device state HA reports is `trusted_system`.
    But on the runtime side it still passes through a clamp — an executor can't claim to be
    the user; see `runtime._executor_trust`.

    A bad output is an observation, not an exception — dispatch never raises (05-executors.md, contract one).
    """

    outcome: Outcome
    trust: Trust
    content: dict[str, Any]
    refs: tuple[MemoryRef, ...] = ()


# R103: the one content-bearing progress field is bounded at every layer.
PROGRESS_SUMMARY_LIMIT = 400


def valid_progress_summary(summary: object, *, phase: str) -> bool:
    """R103 shape: None, or 1..400 printable chars, and only on `working`.

    Shared by the runtime validator and every observer-side consumer — an event
    the validator dropped from Memory still reaches observers unconditionally."""
    if summary is None:
        return True
    return (
        type(summary) is str
        and phase == "working"
        and 1 <= len(summary) <= PROGRESS_SUMMARY_LIMIT
        and not any(unicodedata.category(char).startswith("C") for char in summary)
    )


@dataclass(frozen=True, slots=True)
class ProgressPayload:
    phase: Literal["started", "working"]
    internal_activity: int
    elapsed: float
    summary: str | None = None


@dataclass(frozen=True, slots=True)
class ObservationPayload:
    """A non-terminal executor fact whose identity is bound by Runtime."""

    trust: Trust
    content: dict[str, Any]
    refs: tuple[MemoryRef, ...] = ()


@dataclass(frozen=True, slots=True)
class DispatchContext:
    """What an adapter gets: a clock and this already-bound delegate.

    The clock is the Clock protocol, so the adapter's only suspension point is ctx.clock.sleep().
    """

    clock: Clock
    delegate: Delegate
    progress: Callable[[ProgressPayload], None] | None = None
    observe: Callable[[ObservationPayload], None] | None = None


# ---- The four ports ----


class FastBrain(Protocol):
    """Speak axis -> incremental stream; action axis -> structured output. Floor and "no buffering" both belong to the runtime."""

    def call(self, view: ContextView) -> AsyncIterator[FastBrainDelta]: ...


class Surrogate(Protocol):
    """The decision-maker for "should I speak up when nobody addressed me". **Has only one method, watch** (R21)."""

    async def watch(self, view: ContextView) -> SurrogateOutput: ...


class Compressor(Protocol):
    """Watermark-triggered channel compression; the output is written back to channel.summary.

    The half that already holds true: input, output, and trigger source all differ from
    watch (ContextView -> SurrogateOutput is triggered by memory changes; Sequence[MemoryItem] -> str
    is triggered by the watermark; priority is always 0).

    **The other half of why it's split from Surrogate is fate, and that's a prediction** (R21):
    the eventual full-duplex model will absorb `watch` (deciding whether to speak up is a
    native capability of it), but it won't absorb "write a summary for one channel's
    entries" — that kind of non-realtime batch call. By the yardstick used for these
    tradeoffs, two components with different fates shouldn't share one type — otherwise, on
    the day FastBrain + Surrogate get merged, compress would first have to be peeled off Surrogate.

    Slots have already been separate all along (the `compress` slot isn't called
    `surrogate.compress`); this is just aligning the type to a fact that already holds.
    """

    async def compress(self, items: Sequence[MemoryItem]) -> str: ...


class ExecutorAdapter(Protocol):
    manifest: ExecutorManifest

    async def dispatch(self, op: str, request: dict[str, Any], ctx: DispatchContext) -> Handoff: ...


def bind_delegate(
    request: DelegateRequest,
    *,
    wake_reason: WakeReason,
    op: OpSpec,
    now: float,
    delegate_id: str,
) -> Delegate:
    """The mechanical execution point for the "bound by the runtime, not chosen by the model" list.

    deadline is computed from OpSpec.deadline_budget; routing_class is inherited along the
    causal chain — taking the value already inherited onto **this wake reason**, not
    re-derived from origin_ref (R12).

    `request` is **copied** before being stored. `Delegate` is declared frozen, but a dict
    inside it is a hole in that: the model's `DelegateRequest` and the copy the executor
    holds start out as the same object, and if either one mutates it in place, the dedup
    key (R28), ContextView's `what`, and the snapshot would all quietly drift together.
    Shallow copy: request is a single layer of JSON values; revisit deep-freezing if nested structures show up.
    """
    return Delegate(
        delegate_id=delegate_id,
        executor=request.executor,
        op=request.op,
        request=dict(request.request),
        origin_ref=request.origin_ref,
        deadline=now + op.deadline_budget,
        routing_class=wake_reason.routing_class,
        dispatched_at=now,
    )
