"""Suggestion Pool: where words that couldn't be said land, and the raw
material for proactivity (02-memory.md, section 3).

## Two locks on the state machine

`pending → fired → (cooldown + rearm) → pending`, plus `expired` / `withdrawn`.

**Cooldown expiring doesn't mean it can be said again.** The rule
02-memory.md copied from the media/proactive lesson is: once a trigger
enters cooldown, a repeated match must not notify again until the cooldown
has expired **and** an explicit rearm condition has been observed. Going by
cooldown alone, a suggestion would come back to life on its own every N
seconds, and the user would hear the same line replayed on a timer. So there
are two locks here: `fire` locks it, and `rearm_from` is the only place that
unlocks it, and doing so requires both ① the cooldown has passed and ② a new
observation has really arrived on the channel this suggestion references.

**The explicit condition for rearm is "a new observation on the evidence
channel"** (R35). Three that were rejected:

| Rejected | Why |
|---|---|
| Auto-return to `pending` when cooldown expires | That's exactly what the lesson above is meant to stop — it amounts to no rearm at all |
| Any event rearms | "Source lost, inference failed, cancelled, descriptor changed" would unlock it along the way, and 02-memory.md explicitly disallows that |
| Let the Surrogate rearm explicitly | Its output is only `speak / suggestion_id / reason` (04-ports.md); adding a field would be handing a decision port write access — the pool's writer should be the core |

So a suggestion with an empty `evidence_refs` is one-shot: with no source,
there's no such thing as "the source spoke again." The line from B2 that
Floor pushed down is exactly this case — it's "I wanted to say it a moment
ago but didn't," not an observation that can recur.

## `expired` has no writer; repeat monitors can withdraw superseded hits

Not an oversight. 03-context-view.md requires expiry to be judged **lazily
against `now`** (so the core doesn't need a `tick` event), and that judgment
happens at view-compiling time, which is a pure function and can't write. So
this round, expiry is a predicate (`is_available`), not a stored state.
R136 gives `withdrawn` one narrow writer: when the same active repeat monitor
produces a newer hit, Runtime withdraws its preceding still-pending hit. The
Memory evidence remains append-only; only stale presentation eligibility is
removed. Fired suggestions are never rewritten. `expired` remains a lazy
predicate with no stored-state writer.
**Trigger condition:** once the pool gets persistence, it will need a sweep
to actually reap rows, and that's when `expired` gets a writer.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Literal

from nova_audio_agent.memory import MemoryRef

SuggestionOrigin = Literal["fast_brain", "surrogate", "executor"]
SuggestionKind = Literal["question", "notify", "followup"]
SuggestionStatus = Literal["pending", "fired", "withdrawn", "expired"]

# Once the Surrogate selects a suggestion, the core uses this kind to wake
# FastBrain (the second hop of two-hop speaking).
# It doesn't correspond to any row in the event table: this hop happens in
# apply, with no event. Shaped the same way as REJECTED_WAKE_KIND.
SELECTED_WAKE_KIND = "suggestion_selected"

# Cooldown duration after speaking, in virtual seconds. **This number has no
# empirical basis** — it's only a magnitude that lets test cases construct
# both the "within cooldown" and "after cooldown" sides. The real value has
# to wait for phase C's real-model scorecard — giving it a number that looks
# tuned before then would only invite people to tune it.
DEFAULT_COOLDOWN = 60.0


@dataclass(frozen=True, slots=True)
class Suggestion:
    """One entry in the pool. Nine fields, following 02-memory.md exactly —
    not one more, not one less."""

    id: str
    origin: SuggestionOrigin
    kind: SuggestionKind
    content: dict[str, object]
    evidence_refs: tuple[MemoryRef, ...] = ()
    salience: float = 0.0
    cooldown_until: float = 0.0
    expires_at: float = math.inf
    status: SuggestionStatus = "pending"


def is_available(suggestion: Suggestion, now: float) -> bool:
    """Whether it can be used as material right now. **View-compiling and
    suggestion-selection share this single predicate.**

    This deliberately **doesn't check cooldown again**: `pending` with
    cooldown not yet passed is a state that can't be constructed — `fire` is
    the only place that writes `cooldown_until`, and it also pushes the
    status to `fired` at the same time; the thing that releases it,
    `rearm_from`, already requires the cooldown to have passed on its own.
    Checking "cooldown has passed" a second time looks safer, but really
    it's setting up a second source of truth for the same rule, and if the
    two ever disagree, nobody can say which one to believe.
    """
    return suggestion.status == "pending" and now < suggestion.expires_at


class SuggestionPool:
    """The add/update state machine. The only writer is the core — both
    decision ports only read the affordances it compiles."""

    def __init__(self, *, default_cooldown: float = DEFAULT_COOLDOWN) -> None:
        self._items: list[Suggestion] = []
        self._seq = 0
        self._default_cooldown = default_cooldown

    def add(
        self,
        *,
        origin: SuggestionOrigin,
        kind: SuggestionKind,
        content: dict[str, object],
        evidence_refs: tuple[MemoryRef, ...] = (),
        salience: float = 0.0,
        expires_at: float = math.inf,
    ) -> Suggestion:
        """Adds to the pool. The id is issued by the pool, not given by the
        caller — two suggestions colliding on id is the kind of bug that
        can't be traced.

        `content` **gets copied here, one level deep** (R42). Taking it as-is
        would mean the dict in the caller's hand and the one in the pool are
        the same object, and `_pooled` places it into the affordance
        unchanged — so the claim "a compiled view is an immutable snapshot"
        would be false: the caller mutating its own dict afterward would
        change a view that was already compiled, or even already sent to the
        model. The entire basis for `context_view.py`'s claim of being a
        "pure function" is that the input won't move behind its back.

        The copy is **shallow**: `content` is all scalars today. A deep copy
        of nested values falls under R33's existing trigger condition (once
        `OpSpec` allows nested params), and isn't done preemptively here.
        """
        self._seq += 1
        suggestion = Suggestion(
            id=f"s-{self._seq}",
            origin=origin,
            kind=kind,
            content=dict(content),
            evidence_refs=evidence_refs,
            salience=salience,
            expires_at=expires_at,
        )
        self._items.append(suggestion)
        return suggestion

    def get(self, suggestion_id: str) -> Suggestion | None:
        return next((item for item in self._items if item.id == suggestion_id), None)

    def fire(self, suggestion_id: str, *, now: float, cooldown: float | None = None) -> None:
        """This suggestion **was really spoken**: lock it and start the
        cooldown.

        The call site is after "the text has already entered the sink," not
        at the moment the Surrogate selects it (R26). Marking it at
        selection time would let `defer` and `(none, none)` burn a
        suggestion and start its cooldown for nothing — the user hears not a
        single word, yet the suggestion goes silent for a whole cooldown
        period — proactivity fails silently, and no assertion would ever go
        red for it.

        **Only takes effect on `pending`.** When two watches race and both
        select the same suggestion before the first utterance happens, the
        second utterance would reach here too; without this guard the
        cooldown would be restarted, and the suggestion would sleep an extra
        round for nothing.

        `cooldown=None` (the default) uses the pool's own `default_cooldown`
        (itself `DEFAULT_COOLDOWN` unless the constructor was given the
        push-and-pull proactivity preset's resolved cooldown) — pass an
        explicit value only to override that default for one call.
        """
        index, item = self._locate(suggestion_id)
        if item is None or item.status != "pending":
            return
        resolved_cooldown = self._default_cooldown if cooldown is None else cooldown
        self._items[index] = replace(item, status="fired", cooldown_until=now + resolved_cooldown)

    def withdraw(self, suggestion_id: str) -> bool:
        """Withdraw one exact pending suggestion without deleting its evidence."""
        index, item = self._locate(suggestion_id)
        if item is None or item.status != "pending":
            return False
        self._items[index] = replace(item, status="withdrawn")
        return True

    def rearm_from(self, channel: str, *, now: float) -> None:
        """A new observation arrived on this channel: put back to `pending`
        any cooldown-expired suggestion **that referenced it**.

        The call sites are the two places the core receives **external**
        observations (a user utterance, an executor handoff). The two
        observations the core writes itself (the deadline's `unknown`, a
        rejected-dispatch `failed`) don't count: those are bookkeeping, not
        the world moving again. That line is the actual meaning of "explicit
        rearm condition."
        """
        for index, item in enumerate(self._items):
            if item.status != "fired" or now < item.cooldown_until or now >= item.expires_at:
                continue
            # The colon makes the prefix comparison exact: `slow:` doesn't
            # match `slow_sim:1`.
            if any(ref.startswith(f"{channel}:") for ref in item.evidence_refs):
                self._items[index] = replace(item, status="pending")

    def all(self) -> tuple[Suggestion, ...]:
        """A full snapshot in insertion order. This is what view-compiling
        consumes — **filtering happens at the view-compiling step**,

        because 03-context-view.md requires cooldown and expiry to be
        judged lazily against `now`, and `now` is an input to
        view-compiling. The pool side hands over an immutable full set, so
        nobody can taint the pure function by passing in a live list.
        """
        return tuple(self._items)

    def _locate(self, suggestion_id: str) -> tuple[int, Suggestion | None]:
        for index, item in enumerate(self._items):
            if item.id == suggestion_id:
                return index, item
        return -1, None
