from __future__ import annotations

from collections.abc import Iterator
from itertools import count

from nova_audio_agent.realtime.playback import (
    MAX_RENDERER_TOMBSTONES,
    PlaybackCompletion,
    PlaybackFrame,
    PlaybackGeneration,
    PlaybackRegistry,
)


def ids(*values: str) -> Iterator[str]:
    return iter(values)


def test_unknown_and_fenced_response_pcm_never_reaches_renderer() -> None:
    """Removing response/generation checks would let late provider PCM cross a local fence."""
    frames: list[PlaybackFrame] = []
    clears: list[tuple[str, int]] = []
    id_values = ids("generation-1", "utterance-1")
    playback = PlaybackRegistry(
        id_factory=lambda: next(id_values),
        on_frame=frames.append,
        on_clear=lambda utterance_id, epoch: clears.append((utterance_id, epoch)),
    )

    assert (
        playback.push_audio(
            session_epoch=1,
            response_id="foreign-response",
            pcm=b"\x00\x01",
        )
        is False
    )
    generation = playback.open_response(session_epoch=1, response_id="response-1")
    assert playback.push_audio(
        session_epoch=1,
        response_id="response-1",
        pcm=b"\x00\x01",
    )

    fenced = playback.fence_current()

    assert fenced == generation
    assert clears == [("utterance-1", 1)]
    assert (
        playback.push_audio(
            session_epoch=1,
            response_id="response-1",
            pcm=b"\x02\x03",
        )
        is False
    )
    assert frames == [
        PlaybackFrame(
            utterance_id="utterance-1",
            generation_epoch=1,
            sequence=0,
            pcm=b"\x00\x01",
        )
    ]


def test_interrupted_terminal_cannot_become_spoken_after_buffer_drain() -> None:
    """A cancelled provider turn must not be recorded as fully spoken after PCM drains."""
    id_values = ids("generation-1", "utterance-1")
    playback = PlaybackRegistry(
        id_factory=lambda: next(id_values),
        on_frame=lambda _frame: None,
        on_clear=lambda _utterance_id, _epoch: None,
    )
    generation = playback.open_response(session_epoch=1, response_id="old")
    playback.push_audio(session_epoch=1, response_id="old", pcm=b"\x00\x01")

    assert playback.mark_provider_terminal(
        session_epoch=1,
        response_id="old",
        disposition="interrupted",
    )
    completion = playback.ack_done(
        generation.utterance_id,
        generation.generation_epoch,
        played_ms=20,
    )

    assert completion == PlaybackCompletion(
        session_epoch=1,
        response_id="old",
        utterance_id="utterance-1",
        generation_epoch=1,
        text="",
        disposition="interrupted",
        played_ms=20,
    )


def test_inaudible_interrupted_terminal_is_suppressed() -> None:
    """A cancelled buffered frame with zero playback cannot fabricate interruption audibility."""
    id_values = ids("generation-1", "utterance-1")
    playback = PlaybackRegistry(
        id_factory=lambda: next(id_values),
        on_frame=lambda _frame: None,
        on_clear=lambda _utterance_id, _epoch: None,
    )
    generation = playback.open_response(session_epoch=1, response_id="old")
    playback.push_audio(session_epoch=1, response_id="old", pcm=b"\x00\x01")
    playback.mark_provider_terminal(
        session_epoch=1,
        response_id="old",
        disposition="interrupted",
    )

    completion = playback.ack_done(
        generation.utterance_id,
        generation.generation_epoch,
        played_ms=0,
    )

    assert completion is not None
    assert completion.disposition == "suppressed"


def test_alert_fence_uses_combined_callback_once() -> None:
    """Splitting alert clear and tone into two sends would reopen their ordering race."""
    alerts: list[tuple[str | None, int | None]] = []
    clears: list[tuple[str, int]] = []
    id_values = ids("generation-1", "utterance-1")
    playback = PlaybackRegistry(
        id_factory=lambda: next(id_values),
        on_frame=lambda _frame: None,
        on_clear=lambda utterance_id, epoch: clears.append((utterance_id, epoch)),
        on_alert=lambda utterance_id, epoch: alerts.append((utterance_id, epoch)),
    )
    generation = playback.open_response(session_epoch=1, response_id="old")

    assert playback.fence_current(alert=True) == generation
    assert alerts == [(generation.utterance_id, generation.generation_epoch)]
    assert clears == []


def test_alert_without_current_generation_is_tone_only() -> None:
    """A drained old generation still needs one high-risk cue without fake playback state."""
    alerts: list[tuple[str | None, int | None]] = []
    playback = PlaybackRegistry(
        id_factory=lambda: "unused",
        on_frame=lambda _frame: None,
        on_clear=lambda _utterance_id, _epoch: None,
        on_alert=lambda utterance_id, epoch: alerts.append((utterance_id, epoch)),
    )

    assert playback.fence_current(alert=True) is None
    assert alerts == [(None, None)]
    assert playback.current is None


def test_only_matching_done_ack_produces_delivered_completion_once() -> None:
    """A stale renderer acknowledgement must not commit speech or complete another response."""
    id_values = ids("generation-1", "utterance-1")
    playback = PlaybackRegistry(
        id_factory=lambda: next(id_values),
        on_frame=lambda _frame: None,
        on_clear=lambda _utterance_id, _epoch: None,
    )
    generation = playback.open_response(session_epoch=1, response_id="response-1")
    playback.push_audio(session_epoch=1, response_id="response-1", pcm=b"\x00\x01")
    playback.set_transcript(
        session_epoch=1,
        response_id="response-1",
        text="已经完成。",
    )
    playback.mark_provider_terminal(session_epoch=1, response_id="response-1")

    assert playback.current == generation
    assert playback.ack_done("foreign", generation.generation_epoch) is None
    completion = playback.ack_done(generation.utterance_id, generation.generation_epoch)

    assert completion is not None
    assert completion.response_id == "response-1"
    assert completion.text == "已经完成。"
    assert completion.disposition == "spoken"
    assert playback.current is None
    assert playback.ack_done(generation.utterance_id, generation.generation_epoch) is None


def test_provider_terminal_retains_transcript_until_renderer_delivery() -> None:
    """Provider completion freezes PCM, not a final transcript that is still in flight."""
    id_values = ids("generation-1", "utterance-1")
    registry = PlaybackRegistry(
        id_factory=lambda: next(id_values),
        on_frame=lambda _frame: None,
        on_clear=lambda _utterance_id, _epoch: None,
    )
    registry.open_response(session_epoch=1, response_id="response-1")
    registry.push_audio(session_epoch=1, response_id="response-1", pcm=b"\x00\x01")

    registry.mark_provider_terminal(session_epoch=1, response_id="response-1")
    assert registry.set_transcript(
        session_epoch=1,
        response_id="response-1",
        text="最终文本",
    )
    completion = registry.ack_done("utterance-1", 1, 100)
    assert completion is not None
    assert completion.text == "最终文本"
    assert (
        registry.set_transcript(
            session_epoch=1,
            response_id="response-1",
            text="更晚文本",
        )
        is False
    )


def test_fenced_generation_retains_transcript_until_renderer_delivery() -> None:
    """A clear fence is not delivery, so its eventual completion keeps the final text."""
    id_values = ids("generation-1", "utterance-1")
    registry = PlaybackRegistry(
        id_factory=lambda: next(id_values),
        on_frame=lambda _frame: None,
        on_clear=lambda _utterance_id, _epoch: None,
    )
    generation = registry.open_response(session_epoch=1, response_id="response-1")
    registry.push_audio(session_epoch=1, response_id="response-1", pcm=b"\x00\x01")
    assert registry.fence_current() == generation

    assert registry.set_transcript(
        session_epoch=1,
        response_id="response-1",
        text="被打断的最终文本",
    )
    completion = registry.record_cleared("utterance-1", 1, played_ms=100)
    assert completion is not None
    assert completion.text == "被打断的最终文本"
    assert (
        registry.set_transcript(
            session_epoch=1,
            response_id="response-1",
            text="更晚文本",
        )
        is False
    )


def test_zero_frame_terminal_releases_without_renderer_completion() -> None:
    """A renderer that received no frame cannot acknowledge an invented utterance."""
    frames: list[PlaybackFrame] = []
    clears: list[tuple[str, int]] = []
    id_values = ids("generation-1", "utterance-1")
    playback = PlaybackRegistry(
        id_factory=lambda: next(id_values),
        on_frame=frames.append,
        on_clear=lambda utterance_id, epoch: clears.append((utterance_id, epoch)),
    )
    generation = playback.open_response(session_epoch=1, response_id="response-1")

    assert playback.mark_provider_terminal(session_epoch=1, response_id="response-1")

    assert playback.current is None
    assert playback.ack_done(generation.utterance_id, generation.generation_epoch) is None
    assert frames == []
    assert clears == []


def test_done_before_provider_terminal_is_not_delivery() -> None:
    """A temporarily drained renderer queue cannot claim provider generation is complete."""
    id_values = ids("generation-1", "utterance-1")
    playback = PlaybackRegistry(
        id_factory=lambda: next(id_values),
        on_frame=lambda _frame: None,
        on_clear=lambda _utterance_id, _epoch: None,
    )
    generation = playback.open_response(session_epoch=1, response_id="response-1")

    assert playback.ack_done(generation.utterance_id, generation.generation_epoch) is None


def test_playback_start_evidence_is_recorded_once() -> None:
    """Repeated renderer start acknowledgements must not replay the start transition."""
    id_values = ids("generation-1", "utterance-1")
    playback = PlaybackRegistry(
        id_factory=lambda: next(id_values),
        on_frame=lambda _frame: None,
        on_clear=lambda _utterance_id, _epoch: None,
    )
    generation = playback.open_response(session_epoch=1, response_id="response-1")

    assert playback.mark_started("foreign", generation.generation_epoch) is False
    assert playback.mark_started(generation.utterance_id, generation.generation_epoch) is True
    assert playback.mark_started(generation.utterance_id, generation.generation_epoch) is False


def test_cleared_after_audible_start_reports_interrupted_delivery_once() -> None:
    """Barge-in must record how much the user actually heard, exactly once."""
    id_values = ids("generation-1", "utterance-1")
    playback = PlaybackRegistry(
        id_factory=lambda: next(id_values),
        on_frame=lambda _frame: None,
        on_clear=lambda _utterance_id, _epoch: None,
    )
    generation = playback.open_response(session_epoch=1, response_id="response-1")
    playback.set_transcript(
        session_epoch=1,
        response_id="response-1",
        text="被打断的话",
    )
    playback.mark_started(generation.utterance_id, generation.generation_epoch)
    assert playback.fence_current() == generation

    completion = playback.record_cleared(
        generation.utterance_id, generation.generation_epoch, played_ms=350
    )

    assert completion is not None
    assert completion.disposition == "interrupted"
    assert completion.started is True
    assert completion.played_ms == 350
    assert completion.text == "被打断的话"
    assert (
        playback.record_cleared(generation.utterance_id, generation.generation_epoch, played_ms=350)
        is None
    )


def test_cleared_with_positional_evidence_but_no_start_ack_is_still_interrupted() -> None:
    """A start acknowledgement racing the fence must not hide audio the user heard."""
    id_values = ids("generation-1", "utterance-1")
    playback = PlaybackRegistry(
        id_factory=lambda: next(id_values),
        on_frame=lambda _frame: None,
        on_clear=lambda _utterance_id, _epoch: None,
    )
    generation = playback.open_response(session_epoch=1, response_id="response-1")
    playback.fence_current()

    completion = playback.record_cleared(
        generation.utterance_id, generation.generation_epoch, played_ms=120
    )

    assert completion is not None
    assert completion.disposition == "interrupted"
    assert completion.started is False


def test_cleared_before_any_audible_audio_reports_suppressed() -> None:
    """Fencing before the renderer played anything must not claim the user heard speech."""
    id_values = ids("generation-1", "utterance-1")
    playback = PlaybackRegistry(
        id_factory=lambda: next(id_values),
        on_frame=lambda _frame: None,
        on_clear=lambda _utterance_id, _epoch: None,
    )
    generation = playback.open_response(session_epoch=1, response_id="response-1")
    playback.fence_current()

    completion = playback.record_cleared(
        generation.utterance_id, generation.generation_epoch, played_ms=0
    )

    assert completion is not None
    assert completion.disposition == "suppressed"
    assert completion.played_ms == 0


def test_record_cleared_requires_local_fence() -> None:
    """A cleared acknowledgement for an unfenced generation is stale renderer evidence."""
    id_values = ids("generation-1", "utterance-1")
    playback = PlaybackRegistry(
        id_factory=lambda: next(id_values),
        on_frame=lambda _frame: None,
        on_clear=lambda _utterance_id, _epoch: None,
    )
    generation = playback.open_response(session_epoch=1, response_id="response-1")

    assert (
        playback.record_cleared(generation.utterance_id, generation.generation_epoch, played_ms=10)
        is None
    )


def test_done_acknowledgement_carries_positional_evidence() -> None:
    id_values = ids("generation-1", "utterance-1")
    playback = PlaybackRegistry(
        id_factory=lambda: next(id_values),
        on_frame=lambda _frame: None,
        on_clear=lambda _utterance_id, _epoch: None,
    )
    generation = playback.open_response(session_epoch=1, response_id="response-1")
    playback.push_audio(session_epoch=1, response_id="response-1", pcm=b"\x00\x01")
    playback.mark_started(generation.utterance_id, generation.generation_epoch)
    playback.mark_provider_terminal(session_epoch=1, response_id="response-1")

    completion = playback.ack_done(
        generation.utterance_id, generation.generation_epoch, played_ms=1234
    )

    assert completion is not None
    assert completion.disposition == "spoken"
    assert completion.started is True
    assert completion.played_ms == 1234


def test_large_provider_delta_is_split_into_ordered_bounded_renderer_frames() -> None:
    frames: list[PlaybackFrame] = []
    id_values = ids("generation-1", "utterance-1")
    playback = PlaybackRegistry(
        id_factory=lambda: next(id_values),
        on_frame=frames.append,
        on_clear=lambda _utterance_id, _epoch: None,
    )
    playback.open_response(session_epoch=1, response_id="response-1")
    max_frame_bytes = 64 * 1024
    pcm = b"\x00\x01" * (max_frame_bytes // 2 + 17)

    assert playback.push_audio(session_epoch=1, response_id="response-1", pcm=pcm)
    assert [frame.sequence for frame in frames] == [0, 1]
    assert b"".join(frame.pcm for frame in frames) == pcm
    assert all(0 < len(frame.pcm) <= max_frame_bytes for frame in frames)


def test_unreported_fence_is_visible_until_its_delivery_report() -> None:
    """A fenced generation occupies the foreground until the renderer reports it."""
    id_values = ids("generation-1", "utterance-1")
    playback = PlaybackRegistry(
        id_factory=lambda: next(id_values),
        on_frame=lambda _frame: None,
        on_clear=lambda _utterance_id, _epoch: None,
    )
    assert playback.has_unreported_fence is False
    generation = playback.open_response(session_epoch=1, response_id="response-1")

    playback.fence_current()

    assert playback.has_unreported_fence is True
    playback.record_cleared(generation.utterance_id, generation.generation_epoch, played_ms=10)
    assert playback.has_unreported_fence is False


def test_provider_mutations_are_qualified_by_session_epoch_when_response_id_repeats() -> None:
    """A replacement session may reuse a provider response ID while old renderer state lives."""
    frames: list[PlaybackFrame] = []
    clears: list[tuple[str, int]] = []
    id_values = ids(
        "generation-old",
        "utterance-old",
        "generation-new",
        "utterance-new",
    )
    playback = PlaybackRegistry(
        id_factory=lambda: next(id_values),
        on_frame=frames.append,
        on_clear=lambda utterance_id, epoch: clears.append((utterance_id, epoch)),
    )
    old = playback.open_response(session_epoch=1, response_id="reused")
    assert playback.push_audio(
        session_epoch=1,
        response_id="reused",
        pcm=b"\x00\x01",
    )
    assert playback.switch_generation(old)

    new = playback.open_response(session_epoch=2, response_id="reused")
    assert playback.push_audio(
        session_epoch=2,
        response_id="reused",
        pcm=b"\x02\x03",
    )
    assert (
        playback.push_audio(
            session_epoch=3,
            response_id="reused",
            pcm=b"\x04\x05",
        )
        is False
    )
    assert playback.set_transcript(
        session_epoch=1,
        response_id="reused",
        text="old text",
    )
    assert playback.set_transcript(
        session_epoch=2,
        response_id="reused",
        text="new text",
    )
    assert playback.mark_provider_terminal(session_epoch=2, response_id="reused")

    old_completion = playback.record_cleared(
        old.utterance_id,
        old.generation_epoch,
        played_ms=10,
    )
    new_completion = playback.ack_done(
        new.utterance_id,
        new.generation_epoch,
        played_ms=20,
    )

    assert old_completion is not None
    assert old_completion.session_epoch == 1
    assert old_completion.text == "old text"
    assert new_completion is not None
    assert new_completion.session_epoch == 2
    assert new_completion.text == "new text"
    assert clears == [(old.utterance_id, old.generation_epoch)]
    assert [frame.utterance_id for frame in frames] == [
        old.utterance_id,
        new.utterance_id,
    ]


def test_switch_and_alert_fence_require_the_exact_generation() -> None:
    clears: list[tuple[str, int]] = []
    alerts: list[tuple[str | None, int | None]] = []
    id_values = ids(
        "generation-1",
        "utterance-1",
        "generation-2",
        "utterance-2",
    )
    playback = PlaybackRegistry(
        id_factory=lambda: next(id_values),
        on_frame=lambda _frame: None,
        on_clear=lambda utterance_id, epoch: clears.append((utterance_id, epoch)),
        on_alert=lambda utterance_id, epoch: alerts.append((utterance_id, epoch)),
    )
    first = playback.open_response(session_epoch=1, response_id="response")
    wrong_epoch = PlaybackGeneration(
        session_epoch=2,
        generation_epoch=first.generation_epoch,
        generation_id=first.generation_id,
        utterance_id=first.utterance_id,
        response_id=first.response_id,
    )

    assert playback.switch_generation(wrong_epoch) is False
    assert playback.current == first
    assert playback.switch_generation(first) is True
    assert playback.switch_generation(first) is False
    assert clears == [(first.utterance_id, first.generation_epoch)]

    second = playback.open_response(session_epoch=2, response_id="response")
    assert playback.alert_fence_generation(first) is False
    assert playback.current == second
    assert playback.alert_fence_generation(second) is True
    assert playback.alert_fence_generation(second) is False
    assert alerts == [(second.utterance_id, second.generation_epoch)]


def test_retire_clear_unknown_releases_only_exact_generation_and_late_ack_is_inert() -> None:
    id_values = ids(
        "generation-old",
        "utterance-old",
        "generation-new",
        "utterance-new",
    )
    playback = PlaybackRegistry(
        id_factory=lambda: next(id_values),
        on_frame=lambda _frame: None,
        on_clear=lambda _utterance_id, _epoch: None,
    )
    old = playback.open_response(session_epoch=1, response_id="reused")
    playback.push_audio(session_epoch=1, response_id="reused", pcm=b"\x00\x01")
    assert playback.switch_generation(old)
    assert playback.has_unreported_fence is True

    wrong_epoch = PlaybackGeneration(
        session_epoch=2,
        generation_epoch=old.generation_epoch,
        generation_id=old.generation_id,
        utterance_id=old.utterance_id,
        response_id=old.response_id,
    )
    assert playback.retire_clear_unknown(wrong_epoch) is False
    assert playback.has_unreported_fence is True
    assert playback.retire_clear_unknown(old) is True
    assert playback.retire_clear_unknown(old) is False
    assert playback.has_unreported_fence is False

    new = playback.open_response(session_epoch=2, response_id="reused")
    assert (
        playback.record_cleared(
            old.utterance_id,
            old.generation_epoch,
            played_ms=100,
        )
        is None
    )
    assert playback.current == new


def test_normal_retirement_keeps_only_bounded_renderer_tombstones() -> None:
    id_sequence = count(1)
    playback = PlaybackRegistry(
        id_factory=lambda: f"id-{next(id_sequence)}",
        on_frame=lambda _frame: None,
        on_clear=lambda _utterance_id, _epoch: None,
    )
    first: PlaybackGeneration | None = None

    for index in range(MAX_RENDERER_TOMBSTONES + 17):
        generation = playback.open_response(
            session_epoch=1,
            response_id=f"response-{index}",
        )
        if first is None:
            first = generation
        assert playback.push_audio(
            session_epoch=1,
            response_id=generation.response_id,
            pcm=b"\x00\x01",
        )
        assert playback.mark_provider_terminal(
            session_epoch=1,
            response_id=generation.response_id,
        )
        assert (
            playback.ack_done(
                generation.utterance_id,
                generation.generation_epoch,
            )
            is not None
        )

    assert first is not None
    assert playback.current is None
    assert len(playback._renderer_tombstones) == MAX_RENDERER_TOMBSTONES
    assert playback.ack_done(first.utterance_id, first.generation_epoch) is None
