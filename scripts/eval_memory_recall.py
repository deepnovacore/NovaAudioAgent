#!/usr/bin/env python3
"""Run the opt-in live Qwen memory-recall smoke test.

This is deliberately outside the default test suite. It opens two fresh production
Qwen realtime sessions: one historical question that must call ``memory__recall``
and ground its answer in a Memory-only fact, then one ordinary greeting that must
not call recall. The report contains bounded metadata, never credentials, raw tool
arguments, or recalled evidence bodies.

Exit codes: 0 pass, 1 semantic gate failure, 2 invalid live harness.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import subprocess
import tempfile
from collections.abc import AsyncIterator
from dataclasses import asdict, dataclass
from itertools import count
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from nova_audio_agent.clock import RealClock
from nova_audio_agent.config import ConfigurationError, Settings
from nova_audio_agent.executors.watcher import WATCH_MANIFEST
from nova_audio_agent.memory import CONVERSATION_CHANNEL, Memory
from nova_audio_agent.realtime.bridge import RealtimeRuntimeBridge
from nova_audio_agent.realtime.playback import (
    PlaybackCompletion,
    PlaybackFrame,
    PlaybackGeneration,
    PlaybackRegistry,
)
from nova_audio_agent.realtime.protocol import (
    HostContextItem,
    HostResponseIntent,
    ItemIdentity,
    RealtimeFrontBrainEvent,
    ResponseAudioDelta,
    ResponseStarted,
    ResponseTerminal,
    ResponseTranscriptFinal,
    SessionIdentity,
    ToolCallReady,
    UserTranscriptFinal,
)
from nova_audio_agent.realtime.qwen import QwenAudioRealtimeAdapter
from nova_audio_agent.realtime.service import RealtimeService
from nova_audio_agent.realtime.session import RealtimeSession
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.tool_schema import compile_tool_schema

EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_HARNESS_INVALID = 2
UPLINK_SAMPLE_RATE = 16_000
UPLINK_CHUNK_BYTES = 1280
TRAILING_SILENCE_CHUNKS = 25
PLAYBACK_BYTES_PER_MS = 48
RECALL_QUESTION = "我之前让摄像头看到的蓝色水杯编号是多少？"
NEGATIVE_QUESTION = "请用一句话跟我打个招呼。"


class HarnessInvalid(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class CaseResult:
    case: str
    tool_calls: tuple[str, ...]
    accepted: bool | None
    inline_fulfilled: bool | None
    delegate_id: str | None
    sync_result: bool | None
    hit_refs: tuple[str, ...]
    answer: str
    first_audio_ms: float | None
    first_audio_before_transcript_final: bool | None
    trigger_ms: float | None
    proposal_before_transcript_final: bool | None
    recall_ms: float | None
    memory_unchanged: bool
    injected_kinds: tuple[str, ...]


def evaluate_results(recall: CaseResult, negative: CaseResult) -> dict[str, object]:
    """Apply direction-only live gates; latency is observed, not thresholded yet."""
    gates = [
        {
            "name": "recall_trigger",
            "passed": recall.tool_calls == ("memory__recall",),
        },
        {
            "name": "inline_contract",
            "passed": (
                recall.accepted is True
                and recall.inline_fulfilled is True
                and recall.delegate_id is None
                and recall.sync_result is False
                and recall.memory_unchanged
                and recall.injected_kinds == ("tool_output",)
            ),
        },
        {
            "name": "evidence_reached_provider",
            "passed": "watch:1" in recall.hit_refs,
        },
        {
            "name": "grounded_answer",
            "passed": bool(recall.answer.strip())
            and ("七十二" in recall.answer or "72" in recall.answer),
        },
        {
            "name": "latency_observed",
            "passed": all(
                value is not None and value >= 0
                for value in (recall.first_audio_ms, recall.trigger_ms, recall.recall_ms)
            ),
        },
        {
            "name": "proposal_order_observed",
            "passed": type(recall.proposal_before_transcript_final) is bool,
        },
        {
            "name": "negative_timing_consistent",
            "passed": (
                negative.first_audio_ms is not None
                and type(negative.first_audio_before_transcript_final) is bool
                and (negative.first_audio_ms < 0) is negative.first_audio_before_transcript_final
            ),
        },
        {
            "name": "negative_control",
            "passed": not negative.tool_calls and bool(negative.answer.strip()),
        },
    ]
    return {"passed": all(bool(gate["passed"]) for gate in gates), "gates": gates}


class _Telemetry:
    def __init__(self, clock: RealClock) -> None:
        self.clock = clock
        self.records: list[tuple[float, str, dict[str, Any]]] = []

    def record(self, kind: str, payload: dict[str, Any]) -> None:
        self.records.append((self.clock.now(), kind, payload))

    def close(self) -> None:
        return None


class _RecordingProvider:
    def __init__(self, inner: QwenAudioRealtimeAdapter, clock: RealClock) -> None:
        self.inner = inner
        self.clock = clock
        self.user_final_at: float | None = None
        self.user_final_event_seq: int | None = None
        self.active_response_id: str | None = None
        self.tool_calls: list[tuple[float, str, str | None]] = []
        self.first_audio: dict[str, float] = {}
        self.first_audio_event_seq: dict[str, int] = {}
        self.transcripts: dict[str, str] = {}
        self.injected_kinds: list[str] = []
        self._event_seq = 0

    async def connect(self, *, tools: tuple[dict[str, Any], ...]) -> SessionIdentity:
        return await self.inner.connect(tools=tools)

    async def send_audio(self, pcm: bytes) -> None:
        await self.inner.send_audio(pcm)

    async def inject_host_item(self, item: HostContextItem) -> ItemIdentity:
        self.injected_kinds.append(item.kind)
        return await self.inner.inject_host_item(item)

    async def create_response(self, intent: HostResponseIntent) -> None:
        await self.inner.create_response(intent)

    async def cancel_response(self, response_id: str) -> None:
        await self.inner.cancel_response(response_id)

    async def close(self) -> None:
        await self.inner.close()

    async def events(self) -> AsyncIterator[RealtimeFrontBrainEvent]:
        async for event in self.inner.events():
            self._event_seq += 1
            now = self.clock.now()
            if isinstance(event, UserTranscriptFinal):
                self.user_final_at = now
                self.user_final_event_seq = self._event_seq
            elif isinstance(event, ResponseStarted):
                self.active_response_id = event.response_id
            elif isinstance(event, ToolCallReady):
                self.tool_calls.append(
                    (now, event.name, event.response_id or self.active_response_id)
                )
            elif isinstance(event, ResponseAudioDelta):
                self.first_audio.setdefault(event.response_id, now)
                self.first_audio_event_seq.setdefault(event.response_id, self._event_seq)
            elif isinstance(event, ResponseTranscriptFinal):
                self.transcripts[event.response_id] = event.text
            elif (
                isinstance(event, ResponseTerminal) and self.active_response_id == event.response_id
            ):
                self.active_response_id = None
            yield event


class _Renderer:
    def __init__(self) -> None:
        self.service: RealtimeService | None = None
        self.bytes_by_generation: dict[tuple[str, int], int] = {}
        self.started: set[tuple[str, int]] = set()
        self.deliveries: list[PlaybackCompletion] = []
        self.changed = asyncio.Event()

    def on_frame(self, frame: PlaybackFrame) -> None:
        service = self._service()
        key = (frame.utterance_id, frame.generation_epoch)
        self.bytes_by_generation[key] = self.bytes_by_generation.get(key, 0) + len(frame.pcm)
        if key not in self.started:
            self.started.add(key)
            service.playback_started(*key)

    def on_clear(self, utterance_id: str, generation_epoch: int) -> None:
        self._service().playback_cleared(utterance_id, generation_epoch, 0)

    def on_terminal(self, generation: PlaybackGeneration) -> None:
        key = (generation.utterance_id, generation.generation_epoch)
        played_ms = self.bytes_by_generation.get(key, 0) // PLAYBACK_BYTES_PER_MS
        self._service().playback_done(*key, played_ms)

    def on_delivery(self, completion: PlaybackCompletion) -> None:
        self.deliveries.append(completion)
        self.changed.set()

    def _service(self) -> RealtimeService:
        if self.service is None:
            raise RuntimeError("renderer is not attached")
        return self.service


def _preflight(settings: Settings) -> tuple[str, str, str, str]:
    for tool in ("say", "ffmpeg"):
        if shutil.which(tool) is None:
            raise HarnessInvalid(f"missing_tool:{tool}")
    try:
        return settings.require_qwen_realtime()
    except ConfigurationError as exc:
        raise HarnessInvalid(f"qwen_configuration:{exc}") from exc


def _synthesize(text: str, directory: Path, case: str) -> bytes:
    aiff = directory / f"{case}.aiff"
    pcm = directory / f"{case}.pcm"
    try:
        subprocess.run(
            ["say", "-v", "Tingting", "-o", str(aiff), text],
            check=True,
            capture_output=True,
            text=True,
        )
        subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(aiff),
                "-f",
                "s16le",
                "-acodec",
                "pcm_s16le",
                "-ar",
                str(UPLINK_SAMPLE_RATE),
                "-ac",
                "1",
                str(pcm),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise HarnessInvalid(f"audio_synthesis:{case}") from exc
    payload = pcm.read_bytes()
    if not payload or len(payload) % 2:
        raise HarnessInvalid(f"invalid_audio:{case}")
    return payload


async def _send_turn(service: RealtimeService, clock: RealClock, pcm: bytes) -> None:
    for offset in range(0, len(pcm), UPLINK_CHUNK_BYTES):
        await service.send_audio(pcm[offset : offset + UPLINK_CHUNK_BYTES])
        await clock.sleep(0.04)
    silence = b"\x00" * UPLINK_CHUNK_BYTES
    for _ in range(TRAILING_SILENCE_CHUNKS):
        await service.send_audio(silence)
        await clock.sleep(0.04)


async def _wait_for_answer(
    recorder: _RecordingProvider,
    renderer: _Renderer,
    *,
    timeout: float,
) -> PlaybackCompletion:
    async with asyncio.timeout(timeout):
        while True:
            origin_ids = {origin for _, _, origin in recorder.tool_calls if origin is not None}
            candidates = [
                completion
                for completion in renderer.deliveries
                if completion.text.strip()
                and (not recorder.tool_calls or completion.response_id not in origin_ids)
            ]
            if candidates:
                return candidates[-1]
            renderer.changed.clear()
            await renderer.changed.wait()


def _seed_memory(clock: RealClock) -> tuple[Memory, tuple[object, ...]]:
    memory = Memory(policies=(WATCH_MANIFEST.policy,))
    memory.append(
        "watch",
        ts=clock.now(),
        trust="untrusted_external",
        priority=WATCH_MANIFEST.policy.priority,
        outcome="ok",
        content={
            "hit": True,
            "condition": "出现蓝色水杯",
            "observation": "摄像头看到蓝色水杯，编号七十二",
        },
    )
    return memory, tuple(memory.channels["watch"].items)


async def _run_case(
    *,
    case: str,
    text: str,
    pcm: bytes,
    endpoint: str,
    model: str,
    voice: str,
    api_key: str,
    timeout: float,
) -> CaseResult:
    del text  # audio is the sole user input to the provider
    clock = RealClock()
    memory, watch_before = _seed_memory(clock)
    runtime = Runtime(clock=clock, memory=memory)
    ids = count(1)

    def next_id() -> str:
        return f"recall_live_{next(ids)}"

    tools = compile_tool_schema((), include_memory_recall=True)
    provider = _RecordingProvider(
        QwenAudioRealtimeAdapter(url=endpoint, api_key=api_key, model=model, voice=voice),
        clock,
    )
    renderer = _Renderer()
    telemetry = _Telemetry(clock)
    playback = PlaybackRegistry(
        id_factory=next_id,
        on_frame=renderer.on_frame,
        on_clear=renderer.on_clear,
    )
    session = RealtimeSession(
        provider=provider,
        playback=playback,
        id_factory=next_id,
        on_delivery=renderer.on_delivery,
        clock=clock,
    )
    bridge = RealtimeRuntimeBridge(runtime=runtime, tools=tools, id_factory=next_id)
    service = RealtimeService(
        provider=provider,
        runtime=runtime,
        tools=tools,
        session=session,
        bridge=bridge,
        id_factory=next_id,
        on_provider_terminal=renderer.on_terminal,
        telemetry=telemetry,
    )
    renderer.service = service
    try:
        await service.start()
        await _send_turn(service, clock, pcm)
        delivery = await _wait_for_answer(provider, renderer, timeout=timeout)
    except TimeoutError as exc:
        raise HarnessInvalid(f"case_timeout:{case}") from exc
    except Exception as exc:
        raise HarnessInvalid(f"case_failed:{case}:{type(exc).__name__}") from exc
    finally:
        await service.close()

    acceptances = service.tool_call_acceptances()
    acceptance = acceptances[-1].acceptance if acceptances else None
    recall_records = [
        (at, payload) for at, kind, payload in telemetry.records if kind == "memory.recall"
    ]
    recall_record_at, recall_record = recall_records[-1] if recall_records else (None, None)
    tool_names = tuple(name for _, name, _ in provider.tool_calls)
    origin_ids = {origin for _, _, origin in provider.tool_calls if origin is not None}
    first_audio_response_id, first_audio_at = next(
        (
            (response_id, at)
            for response_id, at in provider.first_audio.items()
            if not origin_ids or response_id not in origin_ids
        ),
        (None, None),
    )
    # Qwen can propose a function call before emitting UserTranscriptFinal. The
    # bridge intentionally defers execution until that transcript is accepted, so
    # the meaningful trigger is the host-side recall telemetry timestamp.
    trigger_at = recall_record_at
    user_final_at = provider.user_final_at
    proposal_at = provider.tool_calls[0][0] if provider.tool_calls else None
    memory_unchanged = (
        tuple(memory.channels["watch"].items) == watch_before
        and len(memory.channels[CONVERSATION_CHANNEL].items) == 1
    )
    return CaseResult(
        case=case,
        tool_calls=tool_names,
        accepted=None if acceptance is None else acceptance.accepted,
        inline_fulfilled=None if acceptance is None else acceptance.inline_fulfilled,
        delegate_id=None if acceptance is None else acceptance.delegate_id,
        sync_result=None if acceptance is None else acceptance.sync_result,
        hit_refs=()
        if recall_record is None
        else tuple(str(ref) for ref in recall_record.get("hit_refs", ())),
        answer=" ".join(delivery.text.split()),
        first_audio_ms=None
        if first_audio_at is None or user_final_at is None
        else (first_audio_at - user_final_at) * 1000,
        first_audio_before_transcript_final=None
        if first_audio_response_id is None or provider.user_final_event_seq is None
        else provider.first_audio_event_seq[first_audio_response_id]
        < provider.user_final_event_seq,
        trigger_ms=None
        if trigger_at is None or user_final_at is None
        else (trigger_at - user_final_at) * 1000,
        proposal_before_transcript_final=None
        if proposal_at is None or user_final_at is None
        else proposal_at < user_final_at,
        recall_ms=None
        if recall_record is None
        else float(recall_record.get("elapsed", 0.0)) * 1000,
        memory_unchanged=memory_unchanged,
        injected_kinds=tuple(provider.injected_kinds),
    )


async def _run(args: argparse.Namespace) -> int:
    settings = Settings(_env_file=args.env_file)
    endpoint, model, voice, api_key = _preflight(settings)
    if args.output.exists():
        raise HarnessInvalid("output_exists")
    with tempfile.TemporaryDirectory(prefix="nova-memory-recall-live-") as scratch:
        directory = Path(scratch)
        recall_pcm = _synthesize(RECALL_QUESTION, directory, "recall")
        negative_pcm = _synthesize(NEGATIVE_QUESTION, directory, "negative")
        recall = await _run_case(
            case="recall",
            text=RECALL_QUESTION,
            pcm=recall_pcm,
            endpoint=endpoint,
            model=model,
            voice=voice,
            api_key=api_key,
            timeout=args.timeout,
        )
        negative = await _run_case(
            case="negative",
            text=NEGATIVE_QUESTION,
            pcm=negative_pcm,
            endpoint=endpoint,
            model=model,
            voice=voice,
            api_key=api_key,
            timeout=args.timeout,
        )
    evaluation = evaluate_results(recall, negative)
    report = {
        "scenario": "qwen-memory-recall-live-smoke.v1",
        "provider": {
            "endpoint_host": urlsplit(endpoint).hostname or "unknown",
            "model": model,
            "voice": voice,
        },
        "cases": [asdict(recall), asdict(negative)],
        **evaluation,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return EXIT_PASS if evaluation["passed"] else EXIT_FAIL


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=Path(".env"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=45.0)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        return asyncio.run(_run(args))
    except HarnessInvalid as exc:
        print(json.dumps({"status": "harness_invalid", "reason": str(exc)}, ensure_ascii=False))
        return EXIT_HARNESS_INVALID


if __name__ == "__main__":
    raise SystemExit(main())
