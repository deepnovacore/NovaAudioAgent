"""Explicit live smoke/latency probe for the native Volcengine cascade."""

from __future__ import annotations

import argparse
import asyncio
from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path
import time
from typing import Any
import wave

from openai import AsyncOpenAI

from nova_audio_agent.config import Settings
from nova_audio_agent.realtime.protocol import ResponseTerminal
from nova_audio_agent.realtime.qwen import FRONTEND_INSTRUCTIONS
from nova_audio_agent.realtime.volcengine import (
    ArkResponsesClient,
    DoubaoAsrClient,
    DoubaoTtsClient,
    SileroVadConfig,
    SileroVadSegmenter,
    VolcengineCascadedAdapter,
)

_STAGES = (
    "volcengine.vad.end",
    "volcengine.asr.final",
    "volcengine.llm.first_text",
    "volcengine.tts.first_audio",
)
_FRAME_BYTES = 512 * 2
_FRAME_SECONDS = 512 / 16_000


class _ProbeTelemetry:
    def __init__(self) -> None:
        self.records: list[tuple[str, float]] = []

    def record(self, kind: str, payload: dict[str, Any]) -> None:
        del payload
        if kind in _STAGES:
            self.records.append((kind, time.perf_counter()))

    def close(self) -> None:
        return None


def _read_pcm16_wave(path: Path) -> bytes:
    with wave.open(str(path), "rb") as source:
        if (
            source.getnchannels() != 1
            or source.getsampwidth() != 2
            or source.getframerate() != 16_000
            or source.getcomptype() != "NONE"
        ):
            raise ValueError("probe WAV must be uncompressed mono 16 kHz PCM16")
        if source.getnframes() > 16_000 * 30:
            raise ValueError("probe WAV must not exceed 30 seconds")
        pcm = source.readframes(source.getnframes())
    if not pcm:
        raise ValueError("probe WAV contains no audio")
    return pcm


def _stage_latencies(records: Sequence[tuple[str, float]]) -> dict[str, float]:
    timestamps: dict[str, float] = {}
    for kind, timestamp in records:
        if kind not in timestamps:
            timestamps[kind] = timestamp
    if any(stage not in timestamps for stage in _STAGES):
        raise RuntimeError("provider probe did not observe every cascade stage")
    return {
        "speech_end_to_asr_final_ms": (timestamps[_STAGES[1]] - timestamps[_STAGES[0]]) * 1000,
        "asr_final_to_llm_first_text_ms": (timestamps[_STAGES[2]] - timestamps[_STAGES[1]]) * 1000,
        "llm_first_text_to_tts_first_audio_ms": (timestamps[_STAGES[3]] - timestamps[_STAGES[2]])
        * 1000,
        "speech_end_to_tts_first_audio_ms": (timestamps[_STAGES[3]] - timestamps[_STAGES[0]])
        * 1000,
    }


async def _send_realtime_frames(
    adapter: Any,
    pcm: bytes,
    *,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> None:
    for offset in range(0, len(pcm), _FRAME_BYTES):
        frame = pcm[offset : offset + _FRAME_BYTES]
        if len(frame) < _FRAME_BYTES:
            frame += bytes(_FRAME_BYTES - len(frame))
        await adapter.send_audio(frame)
        if offset + _FRAME_BYTES < len(pcm):
            await sleep(_FRAME_SECONDS)


async def _run_once(settings: Settings, pcm: bytes, timeout: float) -> dict[str, float]:
    config = settings.require_volcengine_realtime()
    telemetry = _ProbeTelemetry()
    adapter = VolcengineCascadedAdapter(
        vad=SileroVadSegmenter(
            SileroVadConfig(
                threshold=config.vad_threshold,
                pre_roll_ms=config.vad_pre_roll_ms,
                min_speech_ms=config.vad_min_speech_ms,
                silence_end_ms=config.vad_silence_end_ms,
                speech_pad_ms=config.vad_speech_pad_ms,
                max_utterance_ms=config.vad_max_utterance_ms,
            )
        ),
        asr=DoubaoAsrClient(
            endpoint=config.asr_endpoint,
            api_key=config.asr_api_key,
            resource_id=config.asr_resource_id,
            chunk_ms=config.asr_chunk_ms,
        ),
        ark=ArkResponsesClient(
            client=AsyncOpenAI(
                api_key=config.ark_api_key,
                base_url=config.ark_base_url,
                timeout=30.0,
            ),
            model=config.ark_model,
            instructions=FRONTEND_INSTRUCTIONS,
        ),
        tts=DoubaoTtsClient(
            endpoint=config.tts_endpoint,
            api_key=config.tts_api_key,
            resource_id=config.tts_resource_id,
            voice=config.tts_voice,
            output_sample_rate=config.tts_output_sample_rate,
        ),
        telemetry=telemetry,
    )
    await adapter.connect(tools=())

    async def wait_for_terminal() -> ResponseTerminal:
        async for event in adapter.events():
            if isinstance(event, ResponseTerminal):
                return event
        raise RuntimeError("provider event stream ended early")

    terminal_task = asyncio.create_task(wait_for_terminal())
    try:
        padded = pcm + (b"\x00\x00" * 16_000)
        await _send_realtime_frames(adapter, padded)
        terminal = await asyncio.wait_for(terminal_task, timeout=timeout)
        if terminal.status != "completed":
            raise RuntimeError("provider response did not complete")
        return _stage_latencies(telemetry.records)
    finally:
        terminal_task.cancel()
        await asyncio.gather(terminal_task, return_exceptions=True)
        await adapter.close()


def _nearest_rank(values: Sequence[float], percent: float) -> float:
    ordered = sorted(values)
    index = max(0, int((len(ordered) * percent + 99) // 100) - 1)
    return ordered[index]


async def _main(args: argparse.Namespace) -> int:
    if not args.live:
        raise ValueError("live provider calls require --live")
    pcm = _read_pcm16_wave(args.wav)
    samples = [await _run_once(Settings(), pcm, args.timeout) for _ in range(args.runs)]
    for name in samples[0]:
        values = [sample[name] for sample in samples]
        print(
            f"{name}: count={len(values)} p50={_nearest_rank(values, 50):.1f}ms "
            f"p95={_nearest_rank(values, 95):.1f}ms"
        )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="authorize real provider calls")
    parser.add_argument("--wav", type=Path, required=True, help="mono 16 kHz PCM16 utterance")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--timeout", type=float, default=60.0)
    args = parser.parse_args()
    if args.runs < 1 or args.runs > 20 or args.timeout <= 0:
        parser.error("--runs must be 1..20 and --timeout must be positive")
    try:
        return asyncio.run(_main(args))
    except Exception as exc:
        print(f"volcengine probe failed ({type(exc).__name__})")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
