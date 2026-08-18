from __future__ import annotations

import pytest

from scripts.realtime_probe.telemetry_report import (
    clock_offset_ms,
    compute_metrics,
    percentile_summary,
    render_telemetry_report,
)


def test_percentile_summary_uses_nearest_rank() -> None:
    values = [float(value) for value in range(1, 101)]

    summary = percentile_summary(values)

    assert summary == {"count": 100, "p50": 50.0, "p95": 95.0, "p99": 99.0}


def test_clock_offset_prefers_the_minimum_rtt_sample() -> None:
    records = [
        {
            "ts": 0.0,
            "kind": "clock.sync_sample",
            "payload": {"ping_id": "a", "t_sent": 1.0, "t_received": 1.4, "t_render_ms": 3200.0},
        },
        {
            "ts": 0.0,
            "kind": "clock.sync_sample",
            "payload": {"ping_id": "b", "t_sent": 2.0, "t_received": 2.002, "t_render_ms": 4001.0},
        },
    ]

    offset = clock_offset_ms(records)

    assert offset is not None
    # Best sample: midpoint 2.001s → 2001ms on the Python clock, renderer says 4001ms.
    assert round(offset["offset_ms"], 3) == 2000.0
    assert round(offset["rtt_ms"], 3) == 2.0


def test_metrics_pair_events_within_and_across_clock_domains() -> None:
    records = [
        # sync: renderer clock = python clock + 1000ms, rtt 2ms
        {
            "ts": 0.0,
            "kind": "clock.sync_sample",
            "payload": {"ping_id": "a", "t_sent": 0.0, "t_received": 0.002, "t_render_ms": 1001.0},
        },
        # barge-in round trip on the renderer clock: onset 5000 -> cleared 5120
        {
            "ts": 4.0,
            "kind": "renderer.ack",
            "payload": {"kind": "speech_onset", "speech_id": "s-1", "t_render_ms": 5000.0},
        },
        {
            "ts": 4.2,
            "kind": "renderer.ack",
            "payload": {
                "kind": "playback_cleared",
                "utterance_id": "u-1",
                "generation_epoch": 1,
                "t_render_ms": 5120.0,
            },
        },
        # response started at python 6.0s; renderer heard first audio at 7200ms renderer clock
        # = python 6200ms -> 200ms latency
        {"ts": 6.0, "kind": "provider.response_started", "payload": {"response_id": "r-2"}},
        {
            "ts": 6.1,
            "kind": "renderer.ack",
            "payload": {
                "kind": "playback_started",
                "utterance_id": "u-2",
                "generation_epoch": 2,
                "t_render_ms": 7200.0,
            },
        },
        # host item queue -> injected on the python clock
        {"ts": 10.0, "kind": "hostitem.queued", "payload": {"event_id": "e-1"}},
        {"ts": 10.25, "kind": "hostitem.injected", "payload": {"event_id": "e-1"}},
        # codex dispatch -> first progress
        {"ts": 20.0, "kind": "codex.dispatch", "payload": {"delegate_id": "d-1"}},
        {
            "ts": 23.5,
            "kind": "codex.progress",
            "payload": {"delegate_id": "d-1", "phase": "working", "internal_activity": 1},
        },
    ]

    metrics = compute_metrics(records)

    assert metrics["onset_to_clear_roundtrip_ms"] == [120.0]
    assert metrics["response_to_first_audible_ms"] == [200.0]
    assert metrics["hostitem_queued_to_injected_ms"] == [250.0]
    assert metrics["codex_dispatch_to_first_progress_ms"] == [3500.0]

    report = render_telemetry_report(records)
    assert "onset_to_clear_roundtrip_ms" in report
    assert "offset" in report


def test_barge_metric_ignores_same_speech_refresh_as_a_new_start() -> None:
    records = [
        {
            "ts": 1.0,
            "kind": "renderer.ack",
            "payload": {"kind": "speech_onset", "speech_id": "s-1", "t_render_ms": 1000.0},
        },
        {
            "ts": 1.1,
            "kind": "renderer.ack",
            "payload": {"kind": "speech_onset", "speech_id": "s-1", "t_render_ms": 1100.0},
        },
        {
            "ts": 1.2,
            "kind": "renderer.ack",
            "payload": {"kind": "playback_cleared", "t_render_ms": 1200.0},
        },
    ]

    assert compute_metrics(records)["onset_to_clear_roundtrip_ms"] == [200.0]


def test_barge_metric_uses_one_latest_onset_per_clear() -> None:
    records = [
        {
            "ts": 1.0,
            "kind": "renderer.ack",
            "payload": {"kind": "speech_onset", "speech_id": "s-old", "t_render_ms": 1000.0},
        },
        {
            "ts": 1.1,
            "kind": "renderer.ack",
            "payload": {"kind": "speech_onset", "speech_id": "s-new", "t_render_ms": 1100.0},
        },
        {
            "ts": 1.2,
            "kind": "renderer.ack",
            "payload": {"kind": "playback_cleared", "t_render_ms": 1200.0},
        },
    ]

    assert compute_metrics(records)["onset_to_clear_roundtrip_ms"] == [100.0]


def test_barge_metric_drops_an_onset_outside_the_causality_window() -> None:
    records = [
        {
            "ts": 1.0,
            "kind": "renderer.ack",
            "payload": {"kind": "speech_onset", "speech_id": "s-old", "t_render_ms": 1000.0},
        },
        {
            "ts": 4.001,
            "kind": "renderer.ack",
            "payload": {"kind": "playback_cleared", "t_render_ms": 4001.0},
        },
    ]

    assert compute_metrics(records)["onset_to_clear_roundtrip_ms"] == []


def test_first_frame_to_audible_joins_on_generation_identity() -> None:
    """A started ack from an unrelated generation must not pair with this frame."""
    offset_records = [
        {
            "ts": 0.0,
            "kind": "clock.sync_sample",
            "payload": {"t_sent": 0.0, "t_received": 0.002, "t_render_ms": 1.0},
        }
    ]
    records = offset_records + [
        {
            "ts": 1.0,
            "kind": "playback.first_frame_enqueued",
            "payload": {"utterance_id": "u-1", "generation_epoch": 1},
        },
        # Unrelated generation acks first: must not be paired with u-1.
        {
            "ts": 1.01,
            "kind": "renderer.ack",
            "payload": {
                "kind": "playback_started",
                "utterance_id": "u-2",
                "generation_epoch": 2,
                "t_render_ms": 1010.0,
            },
        },
        {
            "ts": 1.05,
            "kind": "renderer.ack",
            "payload": {
                "kind": "playback_started",
                "utterance_id": "u-1",
                "generation_epoch": 1,
                "t_render_ms": 1100.0,
            },
        },
    ]

    metrics = compute_metrics(records)

    assert len(metrics["first_frame_to_audible_ms"]) == 1
    assert metrics["first_frame_to_audible_ms"][0] == pytest.approx(99.0, abs=1.0)


def test_volcengine_cascade_latency_is_paired_in_pipeline_order() -> None:
    records = [
        {"ts": 1.0, "kind": "volcengine.vad.end", "payload": {}},
        {"ts": 1.1, "kind": "volcengine.asr.final", "payload": {}},
        {"ts": 1.25, "kind": "volcengine.llm.first_text", "payload": {}},
        {"ts": 1.4, "kind": "volcengine.tts.first_audio", "payload": {}},
        {"ts": 2.0, "kind": "volcengine.vad.end", "payload": {}},
        {"ts": 2.2, "kind": "volcengine.asr.final", "payload": {}},
        {"ts": 2.5, "kind": "volcengine.llm.first_text", "payload": {}},
        {"ts": 2.9, "kind": "volcengine.tts.first_audio", "payload": {}},
    ]

    metrics = compute_metrics(records)

    assert metrics["volc_speech_end_to_asr_final_ms"] == pytest.approx([100, 200])
    assert metrics["volc_asr_final_to_llm_first_text_ms"] == pytest.approx([150, 300])
    assert metrics["volc_llm_first_text_to_tts_first_audio_ms"] == pytest.approx([150, 400])
    assert metrics["volc_speech_end_to_tts_first_audio_ms"] == pytest.approx([400, 900])
    report = render_telemetry_report(records)
    assert "volc_speech_end_to_tts_first_audio_ms: count=2 p50=400.0ms p95=900.0ms" in report
