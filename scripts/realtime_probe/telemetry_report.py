"""Offline percentile analysis over realtime telemetry JSONL records.

Percentile math lives here (outside ``src/nova_audio_agent``) because the wall-clock
hygiene scan constrains the production package; this module only reads frozen
records. Cross-clock-domain metrics are aligned with the minimum-RTT loopback
sync sample; the report prints the offset and its RTT next to those metrics so
their uncertainty stays visible.
"""

from __future__ import annotations

import json
import math
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

Record = dict[str, Any]
MAX_BARGE_IN_CLEAR_LATENCY_MS = 2_000.0


def load_records(path: str | Path) -> list[Record]:
    records = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            records.append(json.loads(line))
    return records


def percentile_summary(values: Sequence[float]) -> dict[str, float | int]:
    if not values:
        return {"count": 0}
    ordered = sorted(values)

    def nearest_rank(percent: float) -> float:
        rank = max(1, math.ceil(percent / 100.0 * len(ordered)))
        return ordered[rank - 1]

    return {
        "count": len(ordered),
        "p50": nearest_rank(50),
        "p95": nearest_rank(95),
        "p99": nearest_rank(99),
    }


def clock_offset_ms(records: Iterable[Record]) -> dict[str, float] | None:
    """offset_ms = renderer_ms - python_ms, from the minimum-RTT sync sample."""
    best: dict[str, float] | None = None
    for record in records:
        if record.get("kind") != "clock.sync_sample":
            continue
        payload = record["payload"]
        rtt_s = float(payload["t_received"]) - float(payload["t_sent"])
        midpoint_ms = (float(payload["t_sent"]) + float(payload["t_received"])) / 2.0 * 1000.0
        offset_ms = float(payload["t_render_ms"]) - midpoint_ms
        candidate = {"offset_ms": offset_ms, "rtt_ms": rtt_s * 1000.0}
        if best is None or candidate["rtt_ms"] < best["rtt_ms"]:
            best = candidate
    return best


def _renderer_acks(records: Iterable[Record], kind: str) -> list[Record]:
    return [
        record
        for record in records
        if record.get("kind") == "renderer.ack"
        and record["payload"].get("kind") == kind
        and record["payload"].get("t_render_ms") is not None
    ]


def compute_metrics(records: Sequence[Record]) -> dict[str, list[float]]:
    metrics: dict[str, list[float]] = {
        "onset_to_clear_roundtrip_ms": [],
        "response_to_first_audible_ms": [],
        "first_frame_to_audible_ms": [],
        "hostitem_queued_to_injected_ms": [],
        "codex_dispatch_to_first_progress_ms": [],
        "codex_dispatch_to_handoff_ms": [],
        "volc_speech_end_to_asr_final_ms": [],
        "volc_asr_final_to_llm_first_text_ms": [],
        "volc_llm_first_text_to_tts_first_audio_ms": [],
        "volc_speech_end_to_tts_first_audio_ms": [],
    }
    offset = clock_offset_ms(records)

    # Barge-in round trip: renderer clock only (no cross-domain error).
    first_onset_by_speech: dict[str, float] = {}
    anonymous_onsets: list[float] = []
    for onset in _renderer_acks(records, "speech_onset"):
        payload = onset["payload"]
        t_render_ms = float(payload["t_render_ms"])
        speech_id = payload.get("speech_id")
        if isinstance(speech_id, str) and speech_id:
            previous = first_onset_by_speech.get(speech_id)
            if previous is None or t_render_ms < previous:
                first_onset_by_speech[speech_id] = t_render_ms
        else:
            anonymous_onsets.append(t_render_ms)
    unmatched_onsets = sorted((*first_onset_by_speech.values(), *anonymous_onsets))
    cleared_times = sorted(
        float(ack["payload"]["t_render_ms"]) for ack in _renderer_acks(records, "playback_cleared")
    )
    for cleared_at in cleared_times:
        preceding = [onset_at for onset_at in unmatched_onsets if onset_at <= cleared_at]
        if not preceding:
            continue
        onset_at = preceding[-1]
        unmatched_onsets = [value for value in unmatched_onsets if value > cleared_at]
        latency = cleared_at - onset_at
        if latency <= MAX_BARGE_IN_CLEAR_LATENCY_MS:
            metrics["onset_to_clear_roundtrip_ms"].append(latency)

    # Cross-domain: python event ts -> renderer playback_started t_render_ms.
    if offset is not None:
        started_acks = sorted(
            _renderer_acks(records, "playback_started"),
            key=lambda ack: float(ack["payload"]["t_render_ms"]),
        )

        def first_started_after(python_ts: float, identity: tuple[str, int] | None) -> float | None:
            threshold_ms = python_ts * 1000.0 + offset["offset_ms"]
            for ack in started_acks:
                payload = ack["payload"]
                if (
                    identity is not None
                    and (
                        payload.get("utterance_id"),
                        payload.get("generation_epoch"),
                    )
                    != identity
                ):
                    continue
                t_render = float(payload["t_render_ms"])
                if t_render >= threshold_ms:
                    return t_render - threshold_ms
            return None

        for record in records:
            if record.get("kind") == "provider.response_started":
                # Provider events carry response_id, not the playback identity,
                # so this pairing stays nearest-in-time and is labeled diagnostic.
                delta = first_started_after(float(record["ts"]), None)
                if delta is not None:
                    metrics["response_to_first_audible_ms"].append(delta)
            elif record.get("kind") == "playback.first_frame_enqueued":
                payload = record["payload"]
                delta = first_started_after(
                    float(record["ts"]),
                    (payload.get("utterance_id"), payload.get("generation_epoch")),
                )
                if delta is not None:
                    metrics["first_frame_to_audible_ms"].append(delta)

    # Host item delivery on the python clock.
    queued_at: dict[str, float] = {}
    for record in records:
        if record.get("kind") == "hostitem.queued":
            queued_at.setdefault(record["payload"]["event_id"], float(record["ts"]))
        elif record.get("kind") == "hostitem.injected":
            start = queued_at.pop(record["payload"]["event_id"], None)
            if start is not None:
                metrics["hostitem_queued_to_injected_ms"].append(
                    (float(record["ts"]) - start) * 1000.0
                )

    # Codex delegation segments on the python clock.
    dispatch_at: dict[str, float] = {}
    progress_seen: set[str] = set()
    for record in records:
        payload = record.get("payload", {})
        delegate_id = payload.get("delegate_id")
        if record.get("kind") == "codex.dispatch" and delegate_id is not None:
            dispatch_at.setdefault(delegate_id, float(record["ts"]))
        elif record.get("kind") == "codex.progress" and delegate_id in dispatch_at:
            if delegate_id not in progress_seen:
                progress_seen.add(delegate_id)
                metrics["codex_dispatch_to_first_progress_ms"].append(
                    (float(record["ts"]) - dispatch_at[delegate_id]) * 1000.0
                )
        elif record.get("kind") == "codex.handoff" and delegate_id in dispatch_at:
            metrics["codex_dispatch_to_handoff_ms"].append(
                (float(record["ts"]) - dispatch_at[delegate_id]) * 1000.0
            )

    cascade: dict[str, float] = {}
    for record in records:
        kind = record.get("kind")
        timestamp = float(record["ts"])
        if kind == "volcengine.vad.end":
            cascade = {"speech_end": timestamp}
        elif kind == "volcengine.asr.final" and "speech_end" in cascade:
            cascade["asr_final"] = timestamp
            metrics["volc_speech_end_to_asr_final_ms"].append(
                (timestamp - cascade["speech_end"]) * 1000.0
            )
        elif kind == "volcengine.llm.first_text" and "asr_final" in cascade:
            cascade["llm_first_text"] = timestamp
            metrics["volc_asr_final_to_llm_first_text_ms"].append(
                (timestamp - cascade["asr_final"]) * 1000.0
            )
        elif kind == "volcengine.tts.first_audio" and "llm_first_text" in cascade:
            metrics["volc_llm_first_text_to_tts_first_audio_ms"].append(
                (timestamp - cascade["llm_first_text"]) * 1000.0
            )
            metrics["volc_speech_end_to_tts_first_audio_ms"].append(
                (timestamp - cascade["speech_end"]) * 1000.0
            )
            cascade = {}
    return metrics


def render_telemetry_report(records: Sequence[Record]) -> str:
    offset = clock_offset_ms(records)
    lines = ["# Realtime Telemetry Report", ""]
    if offset is None:
        lines.append("clock offset: unavailable (no sync samples) — cross-domain metrics skipped")
    else:
        lines.append(
            "clock offset (renderer - python): "
            f"{offset['offset_ms']:.3f} ms, min RTT {offset['rtt_ms']:.3f} ms"
        )
    lines.append("")
    for name, values in compute_metrics(records).items():
        summary = percentile_summary(values)
        if summary["count"] == 0:
            lines.append(f"- {name}: no samples")
            continue
        lines.append(
            f"- {name}: count={summary['count']} p50={summary['p50']:.1f}ms "
            f"p95={summary['p95']:.1f}ms p99={summary['p99']:.1f}ms"
        )
    uplink = [record["payload"] for record in records if record.get("kind") == "mic.uplink_summary"]
    if uplink:
        frames = sum(int(entry["frames"]) for entry in uplink)
        total = sum(int(entry["bytes"]) for entry in uplink)
        lines.append(f"- mic uplink: {frames} frames, {total} bytes across {len(uplink)} summaries")
    return "\n".join(lines) + "\n"
