"""Silero VAD v5 streaming segmentation over 16 kHz PCM16."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

SAMPLE_RATE = 16_000
FRAME_SAMPLES = 512
BYTES_PER_SAMPLE = 2


@dataclass(frozen=True, slots=True)
class SileroVadConfig:
    threshold: float = 0.5
    pre_roll_ms: int = 260
    min_speech_ms: int = 250
    silence_end_ms: int = 560
    speech_pad_ms: int = 30
    max_utterance_ms: int = 15_000


@dataclass(frozen=True, slots=True)
class VadEvent:
    kind: Literal["speech_started", "speech_stopped"]
    pre_roll_pcm: bytes = b""
    speech_ms: float = 0.0
    commit: bool = True
    forced: bool = False


class SileroVadSegmenter:
    def __init__(self, config: SileroVadConfig, *, iterator: Any | None = None) -> None:
        self.config = config
        self._iterator = _load_iterator(config) if iterator is None else iterator
        self._frame_buffer = bytearray()
        self._pre_roll = bytearray()
        self._in_speech = False
        self._processed_samples = 0
        self._speech_start_sample: int | None = None

    @property
    def in_speech(self) -> bool:
        return self._in_speech

    def feed(self, pcm: bytes) -> tuple[VadEvent, ...]:
        if type(pcm) is not bytes or not pcm or len(pcm) % BYTES_PER_SAMPLE:
            raise ValueError("audio must be non-empty aligned PCM16 bytes")
        self._frame_buffer.extend(pcm)
        events: list[VadEvent] = []
        frame_bytes = FRAME_SAMPLES * BYTES_PER_SAMPLE
        while len(self._frame_buffer) >= frame_bytes:
            frame = bytes(self._frame_buffer[:frame_bytes])
            del self._frame_buffer[:frame_bytes]
            if not self._in_speech:
                self._remember_pre_roll(frame)
            result = self._process_frame(frame)
            frame_start = self._processed_samples
            self._processed_samples += FRAME_SAMPLES
            if result and "start" in result and not self._in_speech:
                self._in_speech = True
                start = result.get("start")
                self._speech_start_sample = start if type(start) is int else frame_start
                events.append(VadEvent("speech_started", pre_roll_pcm=bytes(self._pre_roll)))
                self._pre_roll.clear()
            forced = self._forced_stop()
            if (result and "end" in result and self._in_speech) or forced:
                events.append(self._stop_event(result, forced=forced))
        return tuple(events)

    def reset(self) -> None:
        self._frame_buffer.clear()
        self._pre_roll.clear()
        self._in_speech = False
        self._processed_samples = 0
        self._speech_start_sample = None
        reset = getattr(self._iterator, "reset_states", None)
        if callable(reset):
            reset()

    def _remember_pre_roll(self, pcm: bytes) -> None:
        if self._in_speech:
            return
        self._pre_roll.extend(pcm)
        limit = max(0, int(SAMPLE_RATE * self.config.pre_roll_ms / 1000)) * BYTES_PER_SAMPLE
        if len(self._pre_roll) > limit > 0:
            del self._pre_roll[:-limit]
        elif limit == 0:
            frame_bytes = FRAME_SAMPLES * BYTES_PER_SAMPLE
            if len(self._pre_roll) > frame_bytes:
                del self._pre_roll[:-frame_bytes]

    def _process_frame(self, pcm: bytes) -> dict[str, Any] | None:
        try:
            import numpy as np

            samples: Any = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        except ImportError:
            from array import array

            integers = array("h")
            integers.frombytes(pcm)
            samples = tuple(value / 32768.0 for value in integers)
        frame: Any = samples
        try:
            import torch

            if hasattr(samples, "dtype"):
                frame = torch.from_numpy(samples)
        except ImportError:
            pass
        try:
            value = self._iterator(frame, return_seconds=False)
        except TypeError:
            value = self._iterator(frame)
        return value if type(value) is dict else None

    def _forced_stop(self) -> bool:
        if not self._in_speech or self._speech_start_sample is None:
            return False
        elapsed_ms = (self._processed_samples - self._speech_start_sample) * 1000 / SAMPLE_RATE
        return elapsed_ms >= self.config.max_utterance_ms

    def _stop_event(self, result: dict[str, Any] | None, *, forced: bool) -> VadEvent:
        end = None if result is None else result.get("end")
        end_sample = end if type(end) is int else self._processed_samples
        start_sample = (
            self._speech_start_sample if self._speech_start_sample is not None else end_sample
        )
        speech_ms = max(0.0, (end_sample - start_sample) * 1000 / SAMPLE_RATE)
        self._in_speech = False
        self._speech_start_sample = None
        return VadEvent(
            "speech_stopped",
            speech_ms=speech_ms,
            commit=speech_ms >= self.config.min_speech_ms,
            forced=forced,
        )


def _load_iterator(config: SileroVadConfig) -> Any:
    try:
        from silero_vad import VADIterator, load_silero_vad
    except ImportError as exc:
        raise RuntimeError("Silero VAD 不可用；请安装 nova-audio-agent[volcengine]") from exc
    model = load_silero_vad(onnx=True)
    return VADIterator(
        model,
        threshold=config.threshold,
        sampling_rate=SAMPLE_RATE,
        min_silence_duration_ms=config.silence_end_ms,
        speech_pad_ms=config.speech_pad_ms,
    )
