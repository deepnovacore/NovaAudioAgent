"""Native Volcengine ASR + Ark + TTS realtime provider."""

from nova_audio_agent.realtime.volcengine.adapter import VolcengineCascadedAdapter
from nova_audio_agent.realtime.volcengine.ark import ArkResponsesClient
from nova_audio_agent.realtime.volcengine.asr import DoubaoAsrClient
from nova_audio_agent.realtime.volcengine.benchmark import (
    AttemptResult,
    BenchmarkCase,
    CaseExpectation,
    CaseScore,
    ModelSummary,
    benchmark_cases,
    candidate_passes_gate,
    run_attempt,
    score_events,
    summarize_model,
)
from nova_audio_agent.realtime.volcengine.tts import DoubaoTtsClient
from nova_audio_agent.realtime.volcengine.vad import SileroVadConfig, SileroVadSegmenter

__all__ = [
    "ArkResponsesClient",
    "AttemptResult",
    "BenchmarkCase",
    "CaseExpectation",
    "CaseScore",
    "DoubaoAsrClient",
    "DoubaoTtsClient",
    "ModelSummary",
    "SileroVadConfig",
    "SileroVadSegmenter",
    "VolcengineCascadedAdapter",
    "benchmark_cases",
    "candidate_passes_gate",
    "run_attempt",
    "score_events",
    "summarize_model",
]
