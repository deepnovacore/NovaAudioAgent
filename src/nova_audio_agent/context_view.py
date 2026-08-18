"""ContextView: the only place that can hold back context bloat (03-context-view.md).

FastBrain **does not read channels directly**; this pure-function layer sits in between. Three reasons (D9):
1. This is the only place that can hold back context bloat — the answer lives here, not in the compression strategy
2. Compression output has a clear landing spot: channel.summary. ContextView reads the summary, not the full history
3. Pure function -> snapshot tests can pin down **exactly what FastBrain sees**

Surrogate shares the same ContextView; the only difference is the prompt (D11, a decision against the naive recommendation, cost recorded in 08-deferred.md).

## Seven fields, each with one system-owned supplier

structured / channels / in_flight / affordances / floor / now / trigger_kind.

`trigger_kind` is the bounded projection of the runtime's current WakeReason. Without it, a model
cannot distinguish a new user constraint from a progress or Handoff wake and may replay historical
instructions. It carries no payload, origin, delegate, thread, or turn identity.

**No revision**: 02-memory.md puts revision on Intent / Goal / Authorization themselves,
so they live inside structured and get pinned along with the snapshot. Adding a view-level revision on top would be an extra layer out of nowhere.

**No last_observed**: the "current value vs. historical observation" pair that the last section of
03-context-view.md wants is carried by things that already exist —
`current = pending` is just that entry showing up in in_flight,
and `last_observed = (value, ts)` is carried by channels.recent[].ts. The same fact shouldn't have two sources.

By the time B4 wraps up, the original six fields all have a supplier: channels / floor / now in
stage A, the writer of structured in B4 (`ActAct=update`), in_flight in B1, and affordances in B4.
M1 adds the seventh supplier: runtime projects the current wake into `trigger_kind`.

## The order of the four affordance sources is pinned

probe -> suggestion -> unresolved_question -> channel_update.

**Probe comes first because that's what testing showed (R31)**, not aesthetics: in the B3 probe, after
an `unknown`, qwen-max blindly re-dispatched the same task two times out of three, and rendering the
recheck probe is the variable that flipped it to 3/3. The remaining three are ordered by
"things it already can't bring itself to say > known open questions > just-arrived observations" —
the more concrete ones come first, because the first two have already had a round of judgment applied
on the model's behalf, while the last one is just a raw observation.

The order has to be pinned because it goes into the snapshot: without a fixed order, every snapshot
would drift with dict iteration order.

## The in-flight table, suggestion pool, and manifest all come in via parameters, not from memory

The first two live in the runtime (`delegates.py` explains why they don't go into the blackboard), and
the manifest lives in the executor registry, so this is the only way to get them here: via parameters.
What the parameters take in is an **immutable snapshot**: passing in a live dict would kill the
"pure function" property on the spot, and that property is the entire basis on which snapshot tests
can pin anything down.

The suggestion-pool parameter takes in the **full set**; cooldown and expiry are filtered here against
`now`. 03-context-view.md wants this decided lazily (so the main loop doesn't need a `tick` event), and
`now` is only available at this step.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from nova_audio_agent.floor import FloorState
from nova_audio_agent.memory import (
    CONVERSATION_CHANNEL,
    Memory,
    MemoryItem,
    MemoryRef,
    StructuredState,
)
from nova_audio_agent.suggestions import Suggestion, is_available

if TYPE_CHECKING:
    # Import only during type checking: ports.py, in turn, needs this module's ContextView.
    # The real dependency direction is ports -> context_view; there must be no back-edge at runtime.
    from nova_audio_agent.ports import Delegate, ExecutorManifest

# Cap on raw entries per channel that go into recent. Once a watermark fires,
# the full-log summary supplies older context without changing the raw log.
RECENT_LIMIT = 5

# The window within which an observation counts as "just arrived", in virtual seconds. Like DEFAULT_COOLDOWN,
# **this number has no empirical basis** — it just needs to let test cases produce both sides of the window.
# The local Stage C scorecard can expose bad behavior, but this value is still not empirically tuned.
FRESH_WINDOW = 30.0


@dataclass(frozen=True, slots=True)
class InFlight:
    """An in-flight task. Exactly seven fields, matching 03-context-view.md verbatim.

    routing_class is **read-only** to the model: it can see that "when this comes back
    I'm guaranteed to speak up again", but it cannot change it (bound at runtime along
    the causal chain, R12).
    """

    delegate_id: str
    what: str
    origin_ref: MemoryRef
    dispatched_at: float
    eta: float
    deadline: float
    routing_class: str


@dataclass(frozen=True, slots=True)
class Affordance:
    """Material, not a talking point (D16).

    conclusive is only meaningful for source=probe: compiled from OpSpec.verifies, defaults to False.
    Without this marker, the model would probe some unrelated observable and then declare success (R13).
    """

    source: Literal["suggestion", "unresolved_question", "channel_update", "probe"]
    ref: str
    content: dict[str, Any]
    conclusive: bool | None = None


@dataclass(frozen=True, slots=True)
class ChannelView:
    """What one channel shows the model: one summary sentence + a handful of recent raw entries.

    `omitted` is **the count of entries pushed out by the recent window**; it makes the
    "summary blind spot" observable: `omitted > 0 and summary is None` means this channel
    has `omitted` entries that are neither in the raw text nor spoken for by anyone.
    Compression is watermark-triggered, so this can still occur before the threshold or
    after a failed/empty compression. The field keeps that temporary blind spot visible.

    Why not the stronger shape `covered_through` ("summary covers up through entry N"):
    Stage C intentionally uses full recomputation and records the snapshot count only
    inside the runtime job. A public cursor would promise incremental coverage semantics
    the implementation does not have. `omitted` reports only a fact derived from a count.
    """

    name: str
    summary: str | None
    recent: tuple[MemoryItem, ...]
    omitted: int = 0


@dataclass(frozen=True, slots=True)
class ContextView:
    structured: StructuredState
    channels: tuple[ChannelView, ...]
    in_flight: tuple[InFlight, ...]
    affordances: tuple[Affordance, ...]
    floor: FloorState
    now: float
    trigger_kind: str | None = None


def compile_context_view(
    memory: Memory,
    floor: FloorState,
    now: float,
    *,
    in_flight: Sequence[Delegate] = (),
    suggestions: Sequence[Suggestion] = (),
    manifests: Sequence[ExecutorManifest] = (),
    selected_suggestion: str | None = None,
    trigger_kind: str | None = None,
    fresh_window: float = FRESH_WINDOW,
) -> ContextView:
    """Pure function: the same inputs compile the same view, and memory is left unchanged."""
    channels = tuple(
        ChannelView(
            name=channel.name,
            summary=channel.summary,
            recent=channel.items[-RECENT_LIMIT:],
            omitted=max(len(channel.items) - RECENT_LIMIT, 0),
        )
        for channel in memory.channels.values()
    )
    return ContextView(
        structured=memory.structured,
        channels=channels,
        # Ordered by (dispatched_at, delegate_id), not by the order the caller passed in:
        # the latter is dict insertion order, and the snapshot would drift with it, so
        # snapshot tests couldn't pin down anything.
        in_flight=tuple(
            _compile_in_flight(delegate, memory)
            for delegate in sorted(in_flight, key=lambda d: (d.dispatched_at, d.delegate_id))
        ),
        affordances=(
            *_probes(channels, manifests),
            *_pooled(suggestions, now=now, selected=selected_suggestion),
            *_unresolved(memory.structured),
            *_updates(channels, now=now, fresh_window=fresh_window),
        ),
        floor=floor,
        now=now,
        trigger_kind=trigger_kind,
    )


def _probes(
    channels: Sequence[ChannelView], manifests: Sequence[ExecutorManifest]
) -> Iterator[Affordance]:
    """For every `unknown` in a channel, lay out the readonly ops that could recheck it (R31).

    **Only scans recent**: entries the model can't see shouldn't produce material it can see,
    and the window itself is the only bound here anyway — without a bound, one long channel
    could generate hundreds of probes.

    What `conclusive` asks is "can this probe **settle** that unknown"; the answer comes from
    matching `OpSpec.verifies` against the op name recorded on that unknown, defaulting to False (R13).
    Both unknown producers write `content["op"]` (the main loop's deadline and the adapter's own
    timeout); when it can't be found, default applies — not "probably can settle it", since that's
    exactly the door through which false success reports would come in.

    **One unknown x each readonly op = one entry.** Today each manifest has exactly one readonly
    op, so that's just one entry. Picking "the first one" would need a sorting rationale, and I
    don't have one; laying all of them out lets the model choose for itself, which is the same
    direction as D9's "push heuristics back onto the model". **Trigger condition**: if a manifest's
    readonly ops grow enough to make this long, either sort the ops or have `verifies` do a first pass of filtering.
    """
    by_name = {manifest.name: manifest for manifest in manifests}
    for channel in channels:
        manifest = by_name.get(channel.name)
        if manifest is None:
            continue
        for item in channel.recent:
            if item.outcome != "unknown":
                continue
            for op in manifest.ops:
                if not op.readonly:
                    continue
                yield Affordance(
                    source="probe",
                    ref=item.ref,
                    content={
                        "executor": manifest.name,
                        "op": op.name,
                        "unknown": dict(item.content),
                    },
                    conclusive=item.content.get("op") in op.verifies,
                )


def _pooled(
    suggestions: Sequence[Suggestion], *, now: float, selected: str | None
) -> Iterator[Affordance]:
    """Whatever the pool currently has ready to show. Cooldown and expiry are decided lazily here against `now`.

    `selected` is the one Surrogate just picked (the second hop of the two-hop speak-up). It's
    **only a marker in content**, not state in the pool: the four `status` values are all persistent,
    while "selected" only lives for the duration of this call; marking it `fired` would be even
    worse — `is_available` would filter it out on the spot.

    **When there's a selected one, this route emits only that one** (R38). B4 probe testing showed:
    with both laid out and only the selected one tagged, qwen-max mentioned the unselected one
    anyway 3/3 times ("How dim should the living-room light go this time? By the way, a reminder —
    looks like the fridge door isn't closed."). The consequence isn't just verbosity: since the
    unselected one never reaches `_lock_spoken`, it **gets said without getting locked**, so its
    cooldown never starts counting, and it sits back on the table again next time — the exact
    scheduled-repeat leak the two locks are meant to block.

    Keeping only one is a structural block, not a wording fix. Stronger-worded tagging tested
    equally well at 3/3, but R28 already answered that path: an explicit prompt instruction saying
    "don't dispatch duplicates" still got ignored 2/3 of the time. Also, wording belongs to stage C's
    rendering; what's decided here is **what's in the view being sent out**.

    When there's no selected one (the plain hop, and the agent's own hop), everything is still
    handed over as-is: the agent has to pick one from the set, and this is its supply. **In the
    plain hop, FastBrain can still see the whole table** — the same hole is still there in that
    path; see note 24, which needs stage C's real rendering to be observable.

    The order the pool gives (pool-insertion order) is kept as-is, not re-sorted by salience: who
    should speak first is Surrogate's judgment call, and re-sorting it here would move that decision
    back into the main loop, when salience already travels along with each item anyway.
    """
    for suggestion in suggestions:
        if not is_available(suggestion, now):
            continue
        if selected is not None and suggestion.id != selected:
            continue
        content: dict[str, Any] = {
            "kind": suggestion.kind,
            "salience": suggestion.salience,
            "evidence_refs": list(suggestion.evidence_refs),
            "suggestion": suggestion.content,
        }
        if suggestion.id == selected:
            content["selected"] = True
        yield Affordance(source="suggestion", ref=suggestion.id, content=content)


def _unresolved(structured: StructuredState) -> Iterator[Affordance]:
    """`Intent.unresolved_questions`: the ones the model has noted for itself but hasn't asked yet.

    ref is written as `intent.q0`, deliberately **not shaped like a MemoryRef**:
    it points to a position in Structured State, not to an observation in a channel.
    If it were encoded as `intent:0`, and the model used it as an `origin_ref` to dispatch a
    task, the first check (parseable) would let it through, and it would fail on the second
    check instead — a later, more confusing failure.
    """
    for index, question in enumerate(structured.intent.unresolved_questions):
        yield Affordance(
            source="unresolved_question",
            ref=f"intent.q{index}",
            content={"question": question},
        )


def _updates(
    channels: Sequence[ChannelView], *, now: float, fresh_window: float = FRESH_WINDOW
) -> Iterator[Affordance]:
    """Other channels just had activity. At most one entry per channel — take its latest.

    **The conversation channel doesn't count**: the model is speaking on that channel right
    now, and what it just said isn't "material". Encoding every user utterance in here would
    just turn this field into a copy of the transcript.

    "Just" is judged by `fresh_window` (default `FRESH_WINDOW`), the same kind of lazy
    evaluation as cooldown. Whether the judgment is accurate is a separate matter — what's
    wanted here is for "how long ago this channel last spoke" to be visible to the model,
    and `ts` is carried along precisely to supply the number that the cross-cutting
    invariant "citing a stale value must carry its observation time" needs.
    """
    for channel in channels:
        if channel.name == CONVERSATION_CHANNEL or not channel.recent:
            continue
        item = channel.recent[-1]
        if now - item.ts > fresh_window:
            continue
        yield Affordance(
            source="channel_update",
            ref=item.ref,
            content={
                "channel": channel.name,
                "ts": item.ts,
                "outcome": item.outcome,
                "observation": dict(item.content),
            },
        )


def _compile_in_flight(delegate: Delegate, memory: Memory) -> InFlight:
    """One in-flight task -> the seven fields the model can see.

    eta is an **absolute virtual timestamp**, same shape as deadline. Giving a relative
    duration would force the model to do its own subtraction, and the `now` it has on hand
    is the view's `now` — if the two ever drift out of step, the time in a stalling remark
    would be wrong.
    """
    policy = memory.policies[delegate.executor]
    return InFlight(
        delegate_id=delegate.delegate_id,
        what=_describe(delegate),
        origin_ref=delegate.origin_ref,
        dispatched_at=delegate.dispatched_at,
        eta=delegate.dispatched_at + policy.typical_latency,
        deadline=delegate.deadline,
        routing_class=delegate.routing_class,
    )


def _describe(delegate: Delegate) -> str:
    """A one-line description of "what task was dispatched". Params are sorted by key name — otherwise the same task could get written up two different ways."""
    params = ", ".join(f"{key}={delegate.request[key]!r}" for key in sorted(delegate.request))
    return f"{delegate.executor}.{delegate.op}({params})"
