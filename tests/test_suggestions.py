"""Suggestion Pool: structure and pool admission (B2) + the two locks on the state machine (B4).

The half added by B4 is the rule 02-memory.md borrowed from media/proactive: **cooldown expiring
does not mean it's clear to speak again**. So the use cases here mostly come in pairs — one verifies
"it stays locked", the other verifies "it doesn't unlock when it shouldn't". Writing only the former
would let an empty `return` implementation pass fully green.
"""

from __future__ import annotations

import math

from nova_audio_agent.suggestions import SuggestionPool, is_available


def test_the_pool_hands_out_ids_itself() -> None:
    """Two suggestions colliding on id is exactly the kind of bug that's invisible in testing, so the
    id is not supplied by the caller."""
    pool = SuggestionPool()

    first = pool.add(origin="fast_brain", kind="notify", content={"text": "灯调好了"})
    second = pool.add(origin="surrogate", kind="question", content={"text": "要开电影吗"})

    assert [first.id, second.id] == ["s-1", "s-2"]
    assert pool.all() == (first, second)  # pool-admission order


def test_a_fresh_suggestion_is_pending_and_does_not_pretend_to_expire() -> None:
    """`cooldown_until=0` / `expires_at=inf` **isn't a placeholder — it's "don't invent a number
    with no evidence behind it"**.

    Making up two numbers that look tuned invites someone later to assume they're policy values and
    start tuning against them.
    """
    pool = SuggestionPool()

    suggestion = pool.add(origin="fast_brain", kind="notify", content={"text": "灯调好了"})

    assert suggestion.status == "pending"
    assert suggestion.cooldown_until == 0.0
    assert suggestion.expires_at == math.inf
    assert is_available(suggestion, now=0.0)


def test_availability_really_filters() -> None:
    """The upgraded version of B2's smoke assertion (section 11, admission item 3).

    The original pool held only one pending item, so it couldn't tell "actually filtering" apart
    from "`return all()`". Now the pool holds three, and two should get filtered out — **one by
    `status`, one by `expires_at`** — each with its own counterexample, so skipping either one turns
    the test red.
    """
    pool = SuggestionPool()
    alive = pool.add(origin="fast_brain", kind="notify", content={"text": "还在"})
    spoken = pool.add(origin="fast_brain", kind="notify", content={"text": "说过了"})
    stale = pool.add(origin="fast_brain", kind="notify", content={"text": "过期了"}, expires_at=5.0)
    pool.fire(spoken.id, now=0.0)

    available = [item.id for item in pool.all() if is_available(item, now=10.0)]

    assert available == [alive.id]
    # Reverse check: `stale` was perfectly usable before it expired, so it's the time that filtered
    # it out above, not something wrong with the item itself.
    assert is_available(pool.get(stale.id), now=1.0)  # type: ignore[arg-type]


def test_firing_locks_it_and_starts_the_cooldown() -> None:
    pool = SuggestionPool()
    suggestion = pool.add(origin="fast_brain", kind="question", content={"text": "要多暗"})

    pool.fire(suggestion.id, now=100.0, cooldown=60.0)

    fired = pool.get(suggestion.id)
    assert fired is not None
    assert fired.status == "fired"
    assert fired.cooldown_until == 160.0
    assert not is_available(fired, now=101.0)


def test_firing_the_same_suggestion_twice_does_not_restart_the_cooldown() -> None:
    """When two watches each pick the same suggestion right before the first one gets spoken, the
    second speaking also goes through `fire`.

    If this isn't blocked, the cooldown gets restarted and the suggestion sleeps through an extra
    round for no reason — even though it's already been said once.
    """
    pool = SuggestionPool()
    suggestion = pool.add(origin="fast_brain", kind="question", content={"text": "要多暗"})

    pool.fire(suggestion.id, now=100.0, cooldown=60.0)
    pool.fire(suggestion.id, now=130.0, cooldown=60.0)

    fired = pool.get(suggestion.id)
    assert fired is not None
    assert fired.cooldown_until == 160.0  # not 190


def test_cooldown_alone_does_not_rearm() -> None:
    """The second of the two locks. **If cooldown were the only thing checked, what the user would
    hear is the same line replayed on a timer.**

    This is a direct copy of 02-memory.md's line: "a repeated match must not notify again until the
    cooldown has expired **and** an explicit rearm condition has been observed."
    """
    pool = SuggestionPool()
    suggestion = pool.add(
        origin="fast_brain",
        kind="notify",
        content={"text": "灯还没调成"},
        evidence_refs=("slow_sim:1",),
    )
    pool.fire(suggestion.id, now=0.0, cooldown=60.0)

    later = pool.get(suggestion.id)
    assert later is not None
    assert not is_available(later, now=10_000.0)  # long past cooldown, still locked


def test_rearm_needs_both_the_cooldown_and_a_new_observation() -> None:
    pool = SuggestionPool()
    suggestion = pool.add(
        origin="fast_brain",
        kind="notify",
        content={"text": "灯还没调成"},
        evidence_refs=("slow_sim:1",),
    )
    pool.fire(suggestion.id, now=0.0, cooldown=60.0)

    # A new observation that arrives before the cooldown expires does not unlock — the two conditions
    # are AND, not OR.
    pool.rearm_from("slow_sim", now=30.0)
    still_locked = pool.get(suggestion.id)
    assert still_locked is not None and still_locked.status == "fired"

    pool.rearm_from("slow_sim", now=70.0)
    rearmed = pool.get(suggestion.id)
    assert rearmed is not None
    assert rearmed.status == "pending"
    assert is_available(rearmed, now=70.0)


def test_rearm_only_looks_at_the_channels_it_cited() -> None:
    """Speaking on another channel doesn't count, and the prefix comparison has to be exact — `slow`
    must not match `slow_sim:1`."""
    pool = SuggestionPool()
    suggestion = pool.add(
        origin="fast_brain",
        kind="notify",
        content={"text": "灯还没调成"},
        evidence_refs=("slow_sim:1",),
    )
    pool.fire(suggestion.id, now=0.0, cooldown=60.0)

    pool.rearm_from("conversation", now=70.0)
    pool.rearm_from("slow", now=70.0)

    locked = pool.get(suggestion.id)
    assert locked is not None and locked.status == "fired"


def test_a_suggestion_without_evidence_is_one_shot() -> None:
    """No source, so there's no such thing as "the source spoke up again".

    The case in B2 that got suppressed by the Floor is exactly this kind — it's "I was about to say
    something and didn't get to", not a recurring observation. **This isn't a missing rearm, it's a
    suggestion with no rearm condition at all.**
    """
    pool = SuggestionPool()
    suggestion = pool.add(origin="fast_brain", kind="question", content={"text": "要多暗"})
    pool.fire(suggestion.id, now=0.0, cooldown=60.0)

    for channel in ("conversation", "slow_sim", "fast_sim"):
        pool.rearm_from(channel, now=10_000.0)

    locked = pool.get(suggestion.id)
    assert locked is not None and locked.status == "fired"


def test_rearm_does_not_touch_a_suggestion_that_never_fired() -> None:
    """The other half of "lost source, failed reasoning, cancellation, changed descriptor — none of
    these must accidentally rearm":

    it also must not turn a suggestion that **hasn't been spoken yet** into something else. It was
    already pending to begin with.
    """
    pool = SuggestionPool()
    suggestion = pool.add(
        origin="fast_brain", kind="notify", content={"text": "在"}, evidence_refs=("slow_sim:1",)
    )

    pool.rearm_from("slow_sim", now=70.0)

    assert pool.all() == (suggestion,)  # not a single field was touched


def test_withdraw_changes_only_pending_suggestion() -> None:
    pool = SuggestionPool()
    pending = pool.add(origin="executor", kind="notify", content={"text": "旧命中"})
    fired = pool.add(origin="executor", kind="notify", content={"text": "已播命中"})
    pool.fire(fired.id, now=0.0)

    assert pool.withdraw(pending.id) is True
    assert pool.withdraw(fired.id) is False
    assert pool.withdraw("s-missing") is False
    assert pool.get(pending.id).status == "withdrawn"  # type: ignore[union-attr]
    assert pool.get(fired.id).status == "fired"  # type: ignore[union-attr]


def test_the_pool_keeps_its_own_copy_of_the_content() -> None:
    """Copies one layer at admission time (R42). **The dict in the caller's hand must not be the
    same object as the one in the pool.**

    If it were kept as-is, `_pooled` would place that same reference straight into the affordance,
    which would make the claim "an assembled view is an immutable snapshot" false: the caller
    mutating its own dict afterward would change a view that's already been assembled — possibly
    already sent to the model — and the entire premise behind `context_view.py`'s "pure function"
    claim is that the input doesn't change behind its back.

    Today's actual caller (`_lock_spoken`) passes an in-place literal that nobody else holds a
    reference to — so this test guards against **the next** caller. That kind of bug never turns any
    assertion red; it just makes some snapshot mismatch occasionally, and tracing it back means
    following the trail hundreds of lines to an in-place mutation.
    """
    content = {"text": "冰箱门好像没关"}
    pool = SuggestionPool()
    suggestion = pool.add(origin="fast_brain", kind="notify", content=content)

    content["text"] = "改成别的了"

    assert suggestion.content == {"text": "冰箱门好像没关"}
    assert pool.get(suggestion.id).content == {"text": "冰箱门好像没关"}  # type: ignore[union-attr]
