from __future__ import annotations

import wave

import pytest

from scripts.smoke_volcengine_realtime import _read_pcm16_wave, _stage_latencies


def test_probe_reads_only_bounded_mono_16k_pcm16(tmp_path) -> None:
    path = tmp_path / "utterance.wav"
    with wave.open(str(path), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(16_000)
        target.writeframes(b"\x01\x00" * 512)

    assert _read_pcm16_wave(path) == b"\x01\x00" * 512


def test_probe_reports_each_cascade_stage_without_content() -> None:
    records = [
        ("volcengine.vad.end", 1.0),
        ("volcengine.asr.final", 1.1),
        ("volcengine.llm.first_text", 1.3),
        ("volcengine.tts.first_audio", 1.6),
    ]

    assert _stage_latencies(records) == pytest.approx(
        {
            "speech_end_to_asr_final_ms": 100,
            "asr_final_to_llm_first_text_ms": 200,
            "llm_first_text_to_tts_first_audio_ms": 300,
            "speech_end_to_tts_first_audio_ms": 600,
        }
    )
