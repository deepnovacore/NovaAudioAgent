#!/usr/bin/env python3
"""Run the consent-gated real-model preflight for selective Codex progress recall."""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import subprocess
import tempfile
from collections.abc import Awaitable
from pathlib import Path
from typing import TypeVar

from openai import AsyncOpenAI

from nova_audio_agent.clock import RealClock
from nova_audio_agent.config import Settings
from nova_audio_agent.evals.codex_progress_recall import evaluate_codex_progress_recall
from nova_audio_agent.events import ProgressEvent, WakeReason
from nova_audio_agent.executors.codex_live import CODEX_LIVE_MANIFEST
from nova_audio_agent.memory import CONVERSATION_CHANNEL, USER_PRIORITY, Memory
from nova_audio_agent.model_adapters import GatewaySurrogate
from nova_audio_agent.model_gateway import OpenAIModelGateway
from nova_audio_agent.ports import Delegate, DelegateRequest, bind_delegate
from nova_audio_agent.realtime.bridge import RealtimeRuntimeBridge
from nova_audio_agent.realtime.playback import (
    PlaybackCompletion,
    PlaybackFrame,
    PlaybackGeneration,
    PlaybackRegistry,
)
from nova_audio_agent.realtime.qwen import QwenAudioRealtimeAdapter
from nova_audio_agent.realtime.protocol import HostContextItem
from nova_audio_agent.realtime.service import RealtimeService
from nova_audio_agent.realtime.session import RealtimeSession
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.tool_schema import compile_tool_schema

EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_HARNESS_INVALID = 2
UPLINK_CHUNK_BYTES = 1280
UPLINK_SAMPLE_RATE = 16_000
TRAILING_SILENCE_CHUNKS = 25
PLAYBACK_BYTES_PER_MS = 48
# A dense one-minute run stays well below these in-memory privacy boundaries.
MAX_LIVE_TELEMETRY_RECORDS = 50_000
MAX_LIVE_TELEMETRY_BYTES = 16 * 1024 * 1024
SYNTHETIC_PROGRESS_FACTS = (
    "检查现有页面后确认：旧版本只把笔记保存在页面内存中，刷新会丢失",
    "自动保存与刷新恢复已完成，Node 测试全部通过",
)
SYNTHETIC_ORIGIN_TEXT = "检查笔记刷新后丢失的原因，并验证自动保存和刷新恢复。"
HISTORICAL_QUESTION = "Codex 刚才记录的旧版本为什么一刷新笔记就没了？只回答它当时记录的原因。"
_T = TypeVar("_T")


class HarnessInvalid(RuntimeError):
    """The opt-in live harness could not produce trustworthy evidence."""


class _NullSink:
    def emit(self, utterance_id: str, text: str) -> None:
        del utterance_id, text

    def end(self, utterance_id: str) -> None:
        del utterance_id


class _Telemetry:
    def __init__(self, clock: RealClock) -> None:
        self._clock = clock
        self.records: list[dict[str, object]] = []
        self._bytes = 0
        self.changed = asyncio.Event()

    def record(self, kind: str, payload: dict[str, object]) -> None:
        record = {"ts": self._clock.now(), "kind": kind, "payload": dict(payload)}
        size = (
            len(json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + 1
        )
        if (
            len(self.records) >= MAX_LIVE_TELEMETRY_RECORDS
            or self._bytes + size > MAX_LIVE_TELEMETRY_BYTES
        ):
            raise HarnessInvalid("live telemetry budget exceeded")
        self.records.append(record)
        self._bytes += size
        self.changed.set()

    def close(self) -> None:
        return None

    def payloads(self, kind: str) -> tuple[dict[str, object], ...]:
        return tuple(
            record["payload"]  # type: ignore[misc]
            for record in self.records
            if record["kind"] == kind
        )


class _Renderer:
    def __init__(self, telemetry: _Telemetry) -> None:
        self.telemetry = telemetry
        self.service: RealtimeService | None = None
        self.bytes_by_generation: dict[tuple[str, int], int] = {}
        self.started: set[tuple[str, int]] = set()
        self.deliveries: list[PlaybackCompletion] = []
        self.changed = asyncio.Event()

    def on_frame(self, frame: PlaybackFrame) -> None:
        key = (frame.utterance_id, frame.generation_epoch)
        self.bytes_by_generation[key] = self.bytes_by_generation.get(key, 0) + len(frame.pcm)
        if key in self.started:
            return
        self.started.add(key)
        self.telemetry.record(
            "renderer.ack",
            {
                "kind": "playback_started",
                "utterance_id": frame.utterance_id,
                "generation_epoch": frame.generation_epoch,
            },
        )
        self._service().playback_started(*key)

    def on_clear(self, utterance_id: str, generation_epoch: int) -> None:
        self.telemetry.record(
            "renderer.ack",
            {
                "kind": "playback_cleared",
                "utterance_id": utterance_id,
                "generation_epoch": generation_epoch,
                "played_ms": 0,
            },
        )
        self._service().playback_cleared(utterance_id, generation_epoch, 0)

    def on_terminal(self, generation: PlaybackGeneration) -> None:
        key = (generation.utterance_id, generation.generation_epoch)
        played_ms = self.bytes_by_generation.get(key, 0) // PLAYBACK_BYTES_PER_MS
        self.telemetry.record(
            "renderer.ack",
            {
                "kind": "playback_done",
                "utterance_id": generation.utterance_id,
                "generation_epoch": generation.generation_epoch,
                "played_ms": played_ms,
            },
        )
        self._service().playback_done(*key, played_ms)

    def on_delivery(self, completion: PlaybackCompletion) -> None:
        self.deliveries.append(completion)
        self.changed.set()

    def _service(self) -> RealtimeService:
        if self.service is None:
            raise RuntimeError("renderer is not attached")
        return self.service


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--consent-send-synthetic-facts", action="store_true")
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--env-file", type=Path, default=Path(".env"))
    parser.add_argument("--timeout", type=float, default=45.0)
    return parser.parse_args(argv)


def _preflight(settings: Settings, *, timeout: float) -> tuple[str, str, str, str, str]:
    if type(timeout) is not float or not 1.0 <= timeout <= 180.0:
        raise HarnessInvalid("timeout must be between 1 and 180 seconds")
    for tool in ("say", "ffmpeg"):
        if shutil.which(tool) is None:
            raise HarnessInvalid(f"missing required local tool: {tool}")
    endpoint, model, voice, realtime_key = settings.require_qwen_realtime()
    model_key = settings.require_api_key()
    return endpoint, model, voice, realtime_key, model_key


def _synthesize_question(directory: Path, *, timeout: float) -> bytes:
    aiff = directory / "historical-question.aiff"
    pcm = directory / "historical-question.pcm"
    try:
        subprocess.run(
            ["say", "-v", "Tingting", "-o", str(aiff), HISTORICAL_QUESTION],
            check=True,
            capture_output=True,
            text=True,
            timeout=timeout,
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
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise HarnessInvalid("historical question audio synthesis failed") from exc
    payload = pcm.read_bytes()
    if not payload or len(payload) % 2:
        raise HarnessInvalid("historical question audio is invalid")
    return payload


async def _stream_question(service: RealtimeService, clock: RealClock, pcm: bytes) -> None:
    for offset in range(0, len(pcm), UPLINK_CHUNK_BYTES):
        await service.send_audio(pcm[offset : offset + UPLINK_CHUNK_BYTES])
        await clock.sleep(0.04)
    silence = b"\x00" * UPLINK_CHUNK_BYTES
    for _ in range(TRAILING_SILENCE_CHUNKS):
        await service.send_audio(silence)
        await clock.sleep(0.04)


async def _await_bounded(
    operation: Awaitable[_T],
    *,
    timeout: float,
    failure: str,
) -> _T:
    try:
        async with asyncio.timeout(timeout):
            return await operation
    except TimeoutError as exc:
        raise HarnessInvalid(failure) from exc


async def _wait_for_records(
    telemetry: _Telemetry,
    kind: str,
    count: int,
    *,
    timeout: float,
) -> None:
    async with asyncio.timeout(timeout):
        while len(telemetry.payloads(kind)) < count:
            telemetry.changed.clear()
            await telemetry.changed.wait()


async def _wait_for_deliveries(
    renderer: _Renderer,
    count: int,
    *,
    timeout: float,
) -> None:
    async with asyncio.timeout(timeout):
        while len(renderer.deliveries) < count:
            renderer.changed.clear()
            await renderer.changed.wait()


def _build_live_harness(
    settings: Settings,
    *,
    endpoint: str,
    model: str,
    voice: str,
    realtime_key: str,
    model_key: str,
) -> tuple[
    Runtime,
    RealtimeService,
    _Telemetry,
    _Renderer,
    QwenAudioRealtimeAdapter,
]:
    clock = RealClock()
    telemetry = _Telemetry(clock)
    gateway = OpenAIModelGateway(
        AsyncOpenAI(api_key=model_key, base_url=settings.model_base_url),
        clock=clock,
    )
    memory = Memory(policies=(CODEX_LIVE_MANIFEST.policy,))
    service_outlet: list[RealtimeService] = []
    runtime = Runtime(
        clock=clock,
        memory=memory,
        surrogate=GatewaySurrogate(gateway, model=settings.surrogate_model),
        sink=_NullSink(),
        on_suggestion_selected=lambda suggestion, reason: service_outlet[0].on_suggestion_selected(
            suggestion, reason
        ),
        on_attention_decision=lambda decision: service_outlet[0].on_attention_decision(decision),
    )
    tools = compile_tool_schema((CODEX_LIVE_MANIFEST,), include_memory_recall=True)
    provider = QwenAudioRealtimeAdapter(
        url=endpoint,
        api_key=realtime_key,
        model=model,
        voice=voice,
    )
    renderer = _Renderer(telemetry)
    serial = 0

    def next_id() -> str:
        nonlocal serial
        serial += 1
        return f"progress_recall_live_{serial}"

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
    service_outlet.append(service)
    renderer.service = service
    return runtime, service, telemetry, renderer, provider


def _bind_synthetic_delegate(runtime: Runtime) -> Delegate:
    now = runtime.clock.now()
    origin = runtime.memory.append(
        CONVERSATION_CHANNEL,
        ts=now,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": SYNTHETIC_ORIGIN_TEXT},
    )
    op = CODEX_LIVE_MANIFEST.op("run")
    if op is None:
        raise RuntimeError("Codex live run operation is unavailable")
    delegate = bind_delegate(
        DelegateRequest(
            executor="codex",
            op="run",
            request={},
            origin_ref=origin.ref,
        ),
        wake_reason=WakeReason(
            kind="realtime_tool",
            priority=USER_PRIORITY,
            routing_class="user_awaited",
        ),
        op=op,
        now=now,
        delegate_id="synthetic-codex-1",
    )
    runtime.delegates.dispatch(delegate)
    return delegate


async def _exercise_live(args: argparse.Namespace) -> object:
    settings = Settings(_env_file=args.env_file)
    endpoint, model, voice, realtime_key, model_key = _preflight(settings, timeout=args.timeout)
    with tempfile.TemporaryDirectory(prefix="nova-progress-recall-live-") as scratch:
        question_pcm = _synthesize_question(Path(scratch), timeout=args.timeout)
        runtime, service, telemetry, renderer, provider = _build_live_harness(
            settings,
            endpoint=endpoint,
            model=model,
            voice=voice,
            realtime_key=realtime_key,
            model_key=model_key,
        )
        try:
            await _await_bounded(
                service.start(),
                timeout=args.timeout,
                failure="live service start timed out",
            )
            await _await_bounded(
                provider.inject_host_item(
                    HostContextItem.progress(
                        host_item_id="synthetic-origin-activation",
                        event_id="synthetic-origin-activation",
                        content=SYNTHETIC_ORIGIN_TEXT,
                    ),
                    as_user_activation=True,
                ),
                timeout=args.timeout,
                failure="synthetic origin activation timed out",
            )
            delegate = _bind_synthetic_delegate(runtime)
            telemetry.record("codex.dispatch", {"delegate_id": delegate.delegate_id})
            for index, summary in enumerate(SYNTHETIC_PROGRESS_FACTS, 1):
                runtime.post(
                    ProgressEvent(
                        channel="codex",
                        delegate_id=delegate.delegate_id,
                        op="run",
                        phase="working",
                        internal_activity=index,
                        elapsed=float(index),
                        summary=summary,
                    )
                )
                await _wait_for_records(
                    telemetry,
                    "attention.decision",
                    index,
                    timeout=args.timeout,
                )
            await _await_bounded(
                service.flush_host_items(),
                timeout=args.timeout,
                failure="selected progress injection timed out",
            )
            selected_count = sum(
                payload.get("selected") is True
                for payload in telemetry.payloads("attention.decision")
            )
            if selected_count:
                await _wait_for_deliveries(renderer, selected_count, timeout=args.timeout)
            delivery_count = len(renderer.deliveries)
            await _await_bounded(
                _stream_question(service, runtime.clock, question_pcm),
                timeout=args.timeout,
                failure="historical question upload timed out",
            )
            await _wait_for_deliveries(renderer, delivery_count + 1, timeout=args.timeout)
        except TimeoutError as exc:
            raise HarnessInvalid("live preflight timed out") from exc
        except (OSError, RuntimeError) as exc:
            raise HarnessInvalid(f"live preflight failed: {type(exc).__name__}") from exc
        finally:
            await _await_bounded(
                service.close(),
                timeout=args.timeout,
                failure="live cleanup timed out",
            )
        return evaluate_codex_progress_recall(
            telemetry.records,
            backend="synthetic_live",
        )


def _write_artifacts(path: Path, report: object) -> None:
    gates = getattr(report, "gates")
    payload = {
        "backend": getattr(report, "backend"),
        "harness_valid": getattr(report, "harness_valid"),
        "passed": getattr(report, "passed"),
        "gates": [{"name": gate.name, "passed": gate.passed} for gate in gates],
        "timings_ms": dict(getattr(report, "timings_ms")),
        "invalid_reason": getattr(report, "invalid_reason"),
    }
    with (path / "report.json").open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    with (path / "safe-events.jsonl").open("x", encoding="utf-8") as handle:
        for record in getattr(report, "safe_events"):
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))


def _prepare_artifacts_dir(path: Path) -> None:
    try:
        path.mkdir(parents=True, exist_ok=False)
    except OSError as exc:
        raise HarnessInvalid("artifacts directory is unavailable") from exc


def _run_live(args: argparse.Namespace) -> int:
    _prepare_artifacts_dir(args.artifacts)
    report = asyncio.run(_exercise_live(args))
    _write_artifacts(args.artifacts, report)
    if not getattr(report, "harness_valid"):
        return EXIT_HARNESS_INVALID
    return EXIT_PASS if getattr(report, "passed") else EXIT_FAIL


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    if not args.consent_send_synthetic_facts:
        print(
            "consent required: synthetic origin, two progress facts, and question audio; "
            "pass --consent-send-synthetic-facts before contacting providers"
        )
        return EXIT_HARNESS_INVALID
    try:
        return _run_live(args)
    except Exception:
        print(json.dumps({"status": "harness_invalid", "reason": "live_harness_invalid"}))
        return EXIT_HARNESS_INVALID


if __name__ == "__main__":
    raise SystemExit(main())
