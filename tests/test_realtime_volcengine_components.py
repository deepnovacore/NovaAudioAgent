from __future__ import annotations

from collections.abc import Iterator
import sys

import pytest
from pydantic import SecretStr

from nova_audio_agent.config import ConfigurationError, Settings
from nova_audio_agent.realtime.volcengine.ark import responses_tool_schema
from nova_audio_agent.realtime.volcengine.tts import TextChunker
from nova_audio_agent.realtime.volcengine.vad import SileroVadConfig, SileroVadSegmenter


def test_volcengine_settings_use_dedicated_keys_and_tts_key_as_asr_fallback() -> None:
    dedicated = Settings(
        realtime_provider="volcengine",
        ark_api_key=SecretStr("ark-secret"),
        doubao_asr_api_key=SecretStr("asr-secret"),
        doubao_bigmodel_api_key=SecretStr("tts-secret"),
        _env_file=None,
    ).require_volcengine_realtime()
    fallback = Settings(
        realtime_provider="volcengine",
        ark_api_key=SecretStr("ark-secret"),
        doubao_bigmodel_api_key=SecretStr("shared-secret"),
        _env_file=None,
    ).require_volcengine_realtime()

    assert dedicated.ark_api_key == "ark-secret"
    assert dedicated.asr_api_key == "asr-secret"
    assert dedicated.tts_api_key == "tts-secret"
    assert fallback.asr_api_key == "shared-secret"


def test_volcengine_settings_reject_missing_credentials_without_exposing_values() -> None:
    settings = Settings(realtime_provider="volcengine", _env_file=None)

    with pytest.raises(ConfigurationError, match="ARK_API_KEY") as failure:
        settings.require_volcengine_realtime()

    assert "secret" not in str(failure.value).lower()


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("volcengine_ark_base_url", "http://ark.example/v3"),
        ("doubao_asr_endpoint", "https://speech.example/asr"),
        ("doubao_tts_endpoint", "wss://user:secret@speech.example/tts"),
        ("volcengine_vad_threshold", 1.1),
        ("volcengine_vad_max_utterance_ms", 100),
    ],
)
def test_volcengine_settings_reject_unsafe_endpoints_and_vad_ranges(
    field: str,
    value: object,
) -> None:
    settings = Settings(
        ark_api_key=SecretStr("ark-secret"),
        doubao_bigmodel_api_key=SecretStr("speech-secret"),
        **{field: value},
        _env_file=None,
    )

    with pytest.raises(ConfigurationError) as failure:
        settings.require_volcengine_realtime()

    assert "speech-secret" not in str(failure.value)


def test_responses_tool_schema_flattens_existing_function_shape() -> None:
    schema = {
        "type": "function",
        "function": {
            "name": "weather__get",
            "description": "查询天气",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    }

    assert responses_tool_schema(schema) == {
        "type": "function",
        "name": "weather__get",
        "description": "查询天气",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    }


def test_tts_chunker_flushes_first_boundary_then_soft_and_hard_limits() -> None:
    chunker = TextChunker(soft_limit=18, hard_limit=48)

    assert chunker.push("是啊，后面的文本") == ("是啊，",)
    assert chunker.push("会继续积累直到这是一个自然的边界。剩余") == (
        "后面的文本会继续积累直到这是一个自然的边界。",
    )
    assert chunker.finish() == ("剩余",)


class _Iterator:
    def __init__(self, results: Iterator[dict[str, int] | None]) -> None:
        self._results = results

    def __call__(self, _frame: object, **_kwargs: object) -> dict[str, int] | None:
        return next(self._results)

    def reset_states(self) -> None:
        return None


def test_vad_buffers_arbitrary_pcm_until_a_512_sample_frame() -> None:
    segmenter = SileroVadSegmenter(
        SileroVadConfig(pre_roll_ms=0),
        iterator=_Iterator(iter([{"start": 0}])),
    )

    assert segmenter.feed(b"\x00\x00" * 511) == ()
    events = segmenter.feed(b"\x00\x00")

    assert tuple(event.kind for event in events) == ("speech_started",)
    assert events[0].pre_roll_pcm == b"\x00\x00" * 512


def test_vad_pre_roll_does_not_include_future_frames_from_same_packet() -> None:
    first = b"\x01\x00" * 512
    future = b"\x02\x00" * 512
    segmenter = SileroVadSegmenter(
        SileroVadConfig(pre_roll_ms=260),
        iterator=_Iterator(iter([{"start": 0}, None])),
    )

    events = segmenter.feed(first + future)

    assert events[0].pre_roll_pcm == first


def test_vad_rejects_misaligned_pcm() -> None:
    segmenter = SileroVadSegmenter(
        SileroVadConfig(),
        iterator=_Iterator(iter(())),
    )

    with pytest.raises(ValueError, match="PCM16"):
        segmenter.feed(b"\x00")


def test_vad_discards_speech_shorter_than_minimum() -> None:
    segmenter = SileroVadSegmenter(
        SileroVadConfig(pre_roll_ms=0, min_speech_ms=250),
        iterator=_Iterator(iter([{"start": 0}, {"end": 3_000}])),
    )

    events = segmenter.feed(b"\x00\x00" * 1_024)

    assert [event.kind for event in events] == ["speech_started", "speech_stopped"]
    assert events[-1].commit is False


def test_vad_forces_an_utterance_end_at_configured_maximum() -> None:
    segmenter = SileroVadSegmenter(
        SileroVadConfig(pre_roll_ms=0, min_speech_ms=0, max_utterance_ms=64),
        iterator=_Iterator(iter([{"start": 0}, None])),
    )

    events = segmenter.feed(b"\x00\x00" * 1_024)

    assert events[-1].kind == "speech_stopped"
    assert events[-1].forced is True
    assert events[-1].commit is True


def test_vad_model_dependency_is_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "silero_vad", None)

    with pytest.raises(RuntimeError, match="volcengine"):
        SileroVadSegmenter(SileroVadConfig())
