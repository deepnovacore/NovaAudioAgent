from __future__ import annotations

import pytest

from nova_audio_agent.context_view import ChannelView, ContextView
from nova_audio_agent.memory import MemoryItem, StructuredState
from nova_audio_agent.media import (
    ImageBudget,
    ImageCandidate,
    MediaStore,
    materialize_images,
    select_image_candidates,
)


def _item(
    channel: str,
    seq: int,
    content: dict[str, object],
    *,
    trust: str = "trusted_system",
) -> MemoryItem:
    return MemoryItem(
        channel=channel,
        seq=seq,
        ts=float(seq),
        trust=trust,  # type: ignore[arg-type]
        priority=40,
        content=content,
    )


def _view(*channels: ChannelView) -> ContextView:
    return ContextView(
        structured=StructuredState(),
        channels=channels,
        in_flight=(),
        affordances=(),
        floor="idle",
        now=10.0,
    )


def test_media_store_hashes_payload_and_evicts_the_least_recently_used_entry() -> None:
    ids = iter(("a", "b", "c"))
    store = MediaStore(max_bytes=6, id_factory=lambda: next(ids))
    first = store.put(
        b"aaa",
        media_type="image/jpeg",
        width=2,
        height=2,
        captured_at=1.0,
    )
    second = store.put(
        b"bb",
        media_type="image/png",
        width=3,
        height=4,
        captured_at=2.0,
    )

    assert first.ref == "media:a"
    assert first.digest == ("9834876dcfb05cb167a5c24953eba58c4ac89b1adf57f28f2f9d09af107ee8f0")
    assert store.get(first.ref) == first

    third = store.put(
        b"ccc",
        media_type="image/jpeg",
        width=5,
        height=6,
        captured_at=3.0,
    )

    assert store.peek(first.ref) == first
    assert store.peek(second.ref) is None
    assert store.peek(third.ref) == third
    assert store.total_bytes == 6


def test_media_store_peek_does_not_change_lru_order() -> None:
    ids = iter(("a", "b", "c"))
    store = MediaStore(max_bytes=4, id_factory=lambda: next(ids))
    first = store.put(b"aa", media_type="image/jpeg", width=1, height=1, captured_at=1.0)
    second = store.put(b"bb", media_type="image/jpeg", width=1, height=1, captured_at=2.0)

    assert store.peek(first.ref) == first
    store.put(b"cc", media_type="image/jpeg", width=1, height=1, captured_at=3.0)

    assert store.peek(first.ref) is None
    assert store.peek(second.ref) == second


def test_select_and_materialize_images_is_camera_first_and_marks_all_three_states() -> None:
    ids = iter(("frame", "old", "new"))
    store = MediaStore(max_bytes=20, id_factory=lambda: next(ids))
    frame = store.put(
        b"camera",
        media_type="image/jpeg",
        width=1280,
        height=720,
        captured_at=8.0,
    )
    old = store.put(
        b"old",
        media_type="image/png",
        width=10,
        height=10,
        captured_at=2.0,
    )
    new = store.put(
        b"new",
        media_type="image/png",
        width=10,
        height=10,
        captured_at=3.0,
    )
    view = _view(
        ChannelView(
            name="conversation",
            summary=None,
            recent=(
                _item(
                    "conversation",
                    1,
                    {"text": "old", "media_refs": (old.ref, "media:evicted")},
                    trust="trusted_user",
                ),
                _item(
                    "conversation",
                    2,
                    {"text": "new", "media_refs": (new.ref,)},
                    trust="trusted_user",
                ),
            ),
        ),
        ChannelView(
            name="cam",
            summary=None,
            recent=(_item("cam", 1, {"media_ref": frame.ref}),),
        ),
    )

    candidates = select_image_candidates(view, visible_frames=1, visible_attachments=2)
    request = materialize_images(
        view,
        candidates,
        store,
        budget=ImageBudget(max_images=2, max_bytes=20),
    )

    assert [(candidate.source, candidate.ref) for candidate in candidates] == [
        ("camera", frame.ref),
        ("attachment", new.ref),
        ("attachment", "media:evicted"),
    ]
    assert [image.ref for image in request.images] == [frame.ref, new.ref]
    assert request.states == {
        old.ref: "record_only",
        "media:evicted": "unavailable",
        new.ref: "attached",
        frame.ref: "attached",
    }


def test_materialization_skips_an_oversized_candidate_and_keeps_scanning() -> None:
    ids = iter(("frame", "new", "old"))
    store = MediaStore(max_bytes=30, id_factory=lambda: next(ids))
    frame = store.put(b"123456", media_type="image/jpeg", width=1, height=1, captured_at=1)
    new = store.put(b"12345", media_type="image/png", width=1, height=1, captured_at=2)
    old = store.put(b"12", media_type="image/png", width=1, height=1, captured_at=3)
    view = _view(
        ChannelView(
            name="conversation",
            summary=None,
            recent=(
                _item(
                    "conversation",
                    1,
                    {"media_refs": (old.ref, new.ref)},
                    trust="trusted_user",
                ),
            ),
        ),
        ChannelView(
            name="cam",
            summary=None,
            recent=(_item("cam", 1, {"media_ref": frame.ref}),),
        ),
    )

    request = materialize_images(
        view,
        select_image_candidates(view),
        store,
        budget=ImageBudget(max_images=5, max_bytes=8),
    )

    assert [image.ref for image in request.images] == [frame.ref, old.ref]
    assert request.total_bytes == 8
    assert request.states[new.ref] == "record_only"


def test_emission_order_is_newest_first_and_disagrees_with_the_rendered_ref_order() -> None:
    """Pin the disagreement instead of letting someone "tidy" it into a silent bug.

    Candidates are emitted newest-first because that is the order the byte budget
    demotes in, while `states` follows view order. With several attachments the two are
    reversed relative to each other, so **emission position carries no binding** — the
    gateway's per-image label is what tells the model which ref it is looking at.
    Aligning these two orders here would restore a positional convention that the
    budget is free to break again the moment sizes differ.
    """
    ids = iter(("first", "second", "third"))
    store = MediaStore(id_factory=lambda: next(ids))
    refs = tuple(
        store.put(word, media_type="image/png", width=1, height=1, captured_at=1.0).ref
        for word in (b"first", b"second", b"third")
    )
    view = _view(
        ChannelView(
            name="conversation",
            summary=None,
            recent=(_item("conversation", 1, {"media_refs": refs}, trust="trusted_user"),),
        )
    )

    request = materialize_images(view, select_image_candidates(view), store)

    assert [image.ref for image in request.images] == list(reversed(refs))
    assert list(request.states) == list(refs)
    assert all(state == "attached" for state in request.states.values())


def test_a_candidate_the_budget_skips_does_not_renew_its_place_in_the_store() -> None:
    """Recency should follow what shipped, not what was merely considered.

    Observable through eviction order: the skipped candidate must be the one that goes
    when space runs out, otherwise an image the model never saw keeps itself alive at the
    expense of one it did see.
    """
    ids = iter(("kept", "skipped", "later"))
    store = MediaStore(max_bytes=20, id_factory=lambda: next(ids))
    kept = store.put(b"a" * 6, media_type="image/png", width=1, height=1, captured_at=1.0)
    skipped = store.put(b"b" * 9, media_type="image/png", width=1, height=1, captured_at=2.0)
    view = _view(
        ChannelView(
            name="conversation",
            summary=None,
            recent=(
                _item(
                    "conversation",
                    1,
                    {"media_refs": (kept.ref, skipped.ref)},
                    trust="trusted_user",
                ),
            ),
        )
    )

    request = materialize_images(
        view,
        (
            ImageCandidate(ref=kept.ref, source="attachment"),
            ImageCandidate(ref=skipped.ref, source="attachment"),
        ),
        store,
        budget=ImageBudget(max_images=5, max_bytes=6),
    )
    assert [image.ref for image in request.images] == [kept.ref]
    assert request.states[skipped.ref] == "record_only"

    store.put(b"c" * 6, media_type="image/png", width=1, height=1, captured_at=3.0)

    assert store.peek(kept.ref) is not None
    assert store.peek(skipped.ref) is None


def test_visual_states_cannot_be_rewritten_after_materialization() -> None:
    """Everything else on this type is frozen; a bare dict was the one writable hole."""
    store = MediaStore()
    entry = store.put(b"x", media_type="image/png", width=1, height=1, captured_at=1.0)
    view = _view(
        ChannelView(
            name="cam",
            summary=None,
            recent=(_item("cam", 1, {"media_ref": entry.ref}),),
        )
    )

    request = materialize_images(view, select_image_candidates(view), store)

    assert request.states[entry.ref] == "attached"
    with pytest.raises(TypeError):
        request.states[entry.ref] = "unavailable"  # type: ignore[index]
