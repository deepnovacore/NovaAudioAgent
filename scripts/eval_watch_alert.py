#!/usr/bin/env python3
"""Run the explicit live ``qwen-watch-alert.v1`` Mac-camera path.

The runner drives the production watcher, vision gateway, runtime projection, Qwen
provider, and renderer acknowledgements. Exit codes: 0 pass, 1 product-gate failure,
2 invalid harness. Credentials and raw frames are never written to artifacts.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import json
import math
import re
import shutil
import subprocess
import tempfile
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import asdict
from pathlib import Path
from typing import Any, Literal

from nova_audio_agent.assembly import build_qwen_realtime_assembly
from nova_audio_agent.config import ConfigurationError, Settings
from nova_audio_agent.evals.watch_alert import (
    SCENARIO_ID,
    evaluate_repeat_watch_alert,
    evaluate_watch_alert,
    sanitize_repeat_board_message,
)
from nova_audio_agent.events import Event, HandoffEvent, ObservationEvent
from nova_audio_agent.executors.watcher import START, parse_watch_verdict
from nova_audio_agent.model_gateway import GatewayCompletion, GatewayImage
from nova_audio_agent.realtime.playback import PlaybackCompletion, PlaybackFrame
from nova_audio_agent.realtime.memory_board import memory_board_message
from nova_audio_agent.tool_schema import CompiledTools

EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_HARNESS_INVALID = 2
OUTPUT_BYTES_PER_MS = 48
MAX_ARTIFACT_TEXT = 400
_ARTIFACT_FIELDS = {
    "dispatch.ack": frozenset({"executor", "delegate_id"}),
    "dispatch.spoken": frozenset({"delegate_id", "transcript"}),
    "vision.verdict": frozenset({"delegate_id", "frame_digest", "hit", "condition", "observation"}),
    "watch.observation": frozenset(
        {"delegate_id", "executor", "event_id", "hit", "state", "hit_count", "reset_count"}
    ),
    "watch.handoff": frozenset({"delegate_id", "executor", "hit", "outcome", "state"}),
    "watch.stop": frozenset(
        {"start_delegate_id", "stop_delegate_id", "outcome", "stopped", "start_state"}
    ),
    "status.sync": frozenset({"executor", "sync_result", "state"}),
    "playback.delivered": frozenset({"delegate_id", "event_id", "transcript"}),
    "renderer.alert": frozenset({"generation_qualified"}),
}
_CREDENTIAL_PATTERNS = (
    re.compile(r"\bsk-[A-Za-z0-9_-]{8,}\b", re.IGNORECASE),
    re.compile(r"\bBearer\s+[^\s]+", re.IGNORECASE),
)
EvidenceTarget = Literal["first-hit", "repeat"]


class HarnessInvalid(RuntimeError):
    pass


class NullSink:
    def emit(self, utterance_id: str, text: str) -> None:
        del utterance_id, text

    def end(self, utterance_id: str) -> None:
        del utterance_id


class Recorder:
    def __init__(self, *, sensitive_values: Sequence[str] = ()) -> None:
        self.started = time.monotonic()
        self.records: list[dict[str, object]] = []
        self.board_message: str | None = None
        self._sensitive_values = tuple(
            sorted(
                {value for value in sensitive_values if isinstance(value, str) and value},
                key=len,
                reverse=True,
            )
        )

    def protect(self, *values: str) -> None:
        self._sensitive_values = tuple(
            sorted(
                {*self._sensitive_values, *(value for value in values if value)},
                key=len,
                reverse=True,
            )
        )

    def add(self, kind: str, data: dict[str, object]) -> None:
        allowed = _ARTIFACT_FIELDS.get(kind)
        if allowed is None:
            raise HarnessInvalid("unsupported_artifact_event")
        sanitized: dict[str, object] = {}
        for key, value in data.items():
            if key not in allowed:
                continue
            if isinstance(value, str):
                sanitized[key] = self._sanitize_text(value)
            elif type(value) is bool:
                sanitized[key] = value
            elif type(value) in {int, float} and math.isfinite(float(value)):
                sanitized[key] = value
        self.records.append(
            {
                "event_ref": f"e{len(self.records) + 1:03d}",
                "t_ms": round((time.monotonic() - self.started) * 1000, 3),
                "kind": kind,
                "data": sanitized,
            }
        )

    def _sanitize_text(self, value: str) -> str:
        text = " ".join(value.split())
        for sensitive in self._sensitive_values:
            text = text.replace(sensitive, "[redacted]")
        for pattern in _CREDENTIAL_PATTERNS:
            text = pattern.sub("[redacted]", text)
        return "".join(character for character in text if character.isprintable())[
            :MAX_ARTIFACT_TEXT
        ]


class Renderer:
    def __init__(self, recorder: Recorder) -> None:
        self.recorder = recorder
        self.service: Any = None
        self.delegate_id: str | None = None
        self.observation: str | None = None
        self.bytes: dict[tuple[str, int], int] = {}
        self.started: set[tuple[str, int]] = set()
        self.delivered = asyncio.Event()
        self.delivered_event_ids: set[str] = set()
        self.acknowledged = asyncio.Event()
        self.response_event_ids: dict[str, tuple[str, ...]] = {}
        self._awaiting_dispatch_acknowledgement = False
        self._dispatch_delegate_id: str | None = None
        self._dispatch_response_id: str | None = None
        self._pending_dispatch_speech: list[tuple[str, str]] = []
        self._hit_response_is_correlated: Callable[[str], bool] | None = None

    def expect_dispatch_acknowledgement(self) -> None:
        self._awaiting_dispatch_acknowledgement = True
        self._dispatch_delegate_id = None
        self._dispatch_response_id = None
        self._pending_dispatch_speech.clear()

    def bind_dispatch_delegate(self, delegate_id: str, response_id: str) -> None:
        self._dispatch_delegate_id = delegate_id
        self._dispatch_response_id = response_id
        transcript = next(
            (
                current_transcript
                for current_response_id, current_transcript in self._pending_dispatch_speech
                if current_response_id == response_id
            ),
            None,
        )
        if transcript is not None:
            self._record_dispatch_acknowledgement(delegate_id, transcript)

    def expect_hit_delivery(
        self,
        *,
        is_correlated: Callable[[str], bool],
    ) -> None:
        self._hit_response_is_correlated = is_correlated

    def on_frame(self, frame: PlaybackFrame) -> None:
        key = (frame.utterance_id, frame.generation_epoch)
        if key not in self.started:
            self.started.add(key)
            self.service.playback_started(*key)
        self.bytes[key] = self.bytes.get(key, 0) + len(frame.pcm)

    def on_clear(self, utterance_id: str, generation_epoch: int) -> None:
        key = (utterance_id, generation_epoch)
        self.service.playback_cleared(
            utterance_id,
            generation_epoch,
            self.bytes.get(key, 0) // OUTPUT_BYTES_PER_MS,
        )

    def on_alert(self, utterance_id: str | None, generation_epoch: int | None) -> None:
        generation_qualified = utterance_id is not None and generation_epoch is not None
        self.recorder.add("renderer.alert", {"generation_qualified": generation_qualified})
        if not generation_qualified or self.service is None:
            return
        key = (utterance_id, generation_epoch)
        self.service.playback_cleared(
            utterance_id,
            generation_epoch,
            self.bytes.get(key, 0) // OUTPUT_BYTES_PER_MS,
        )

    def on_terminal(self, utterance_id: str, generation_epoch: int) -> None:
        key = (utterance_id, generation_epoch)
        generation = self.service.session.current_generation
        if (
            generation is not None
            and generation.utterance_id == utterance_id
            and generation.generation_epoch == generation_epoch
        ):
            self.response_event_ids[generation.response_id] = (
                self.service.session.response_event_ids(generation.response_id)
            )
        self.service.playback_done(
            utterance_id,
            generation_epoch,
            self.bytes.get(key, 0) // OUTPUT_BYTES_PER_MS,
        )

    def on_delivery(self, completion: PlaybackCompletion) -> None:
        transcript = " ".join(completion.text.split())
        spoken = bool(transcript) and completion.disposition == "spoken" and completion.started
        if spoken and self._awaiting_dispatch_acknowledgement:
            if (
                self._dispatch_delegate_id is not None
                and completion.response_id == self._dispatch_response_id
            ):
                self._record_dispatch_acknowledgement(self._dispatch_delegate_id, transcript)
                return
            if self._dispatch_response_id is None:
                self._pending_dispatch_speech.append((completion.response_id, transcript))
        if (
            self.delegate_id
            and self.observation
            and spoken
            and self._hit_response_is_correlated is not None
            and self._hit_response_is_correlated(completion.response_id)
        ):
            event_id = next(
                (
                    event_id
                    for event_id in self.response_event_ids.get(completion.response_id, ())
                    if event_id.startswith("observation:")
                ),
                None,
            )
            self.recorder.add(
                "playback.delivered",
                {
                    "delegate_id": self.delegate_id,
                    "event_id": event_id,
                    "transcript": transcript,
                },
            )
            if event_id is not None:
                self.delivered_event_ids.add(event_id)
            self.delivered.set()

    def _record_dispatch_acknowledgement(self, delegate_id: str, transcript: str) -> None:
        self.recorder.add(
            "dispatch.spoken",
            {"delegate_id": delegate_id, "transcript": transcript},
        )
        self._awaiting_dispatch_acknowledgement = False
        self._dispatch_delegate_id = None
        self._dispatch_response_id = None
        self._pending_dispatch_speech.clear()
        self.acknowledged.set()


class RecordingFrames:
    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.last_digest: str | None = None

    async def snapshot(self) -> Any:
        frame = await self.inner.snapshot()
        if frame is not None:
            self.last_digest = hashlib.sha256(frame.payload).hexdigest()
        return frame


class RecordingGateway:
    def __init__(
        self,
        inner: Any,
        frames: RecordingFrames,
        recorder: Recorder,
        delegate_id: Callable[[], str | None],
        condition: str,
        *,
        release: asyncio.Event | None = None,
        prepare_after_release: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self.inner = inner
        self.frames = frames
        self.recorder = recorder
        self.delegate_id = delegate_id
        self.condition = condition
        self.release = release
        self.prepare_after_release = prepare_after_release
        self._prepared = False

    async def complete(
        self,
        *,
        model: str,
        system: str,
        prompt: str,
        json_schema: dict[str, object] | None = None,
        images: Sequence[GatewayImage] = (),
    ) -> GatewayCompletion:
        if self.release is not None:
            await self.release.wait()
        if self.prepare_after_release is not None and not self._prepared:
            await self.prepare_after_release()
            self._prepared = True
        completion = await self.inner.complete(
            model=model,
            system=system,
            prompt=prompt,
            json_schema=json_schema,
            images=images,
        )
        try:
            verdict = parse_watch_verdict(completion.text)
        except ValueError:
            verdict = None
        if verdict is not None and self.frames.last_digest:
            self.recorder.add(
                "vision.verdict",
                {
                    "delegate_id": self.delegate_id() or "pending",
                    "frame_digest": self.frames.last_digest,
                    "hit": verdict.hit,
                    "condition": self.condition,
                    "observation": verdict.observation,
                },
            )
        return completion


def _write(
    directory: Path,
    recorder: Recorder,
    classification: str,
    reason: str | None,
    *,
    minimum_pre_hit_misses: int = 0,
    evidence_target: EvidenceTarget = "repeat",
) -> bool:
    directory.mkdir(parents=True, exist_ok=True)
    report = evaluate_watch_alert(
        recorder.records,
        backend="live",
        minimum_pre_hit_misses=minimum_pre_hit_misses,
    )
    executor = next(
        (
            value
            for record in recorder.records
            if record.get("kind") == "dispatch.ack"
            and isinstance((data := record.get("data")), dict)
            and isinstance((value := data.get("executor")), str)
        ),
        "",
    )
    board_evidence = ""
    if recorder.board_message and executor:
        try:
            board_evidence = sanitize_repeat_board_message(recorder.board_message, executor)
        except ValueError:
            board_evidence = ""
    repeat_report = evaluate_repeat_watch_alert(
        recorder.records,
        board_message=board_evidence,
        backend="live",
    )
    (directory / "records.jsonl").write_text(
        "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in recorder.records),
        encoding="utf-8",
    )
    (directory / "report.json").write_text(
        json.dumps(
            {
                "scenario_id": SCENARIO_ID,
                "classification": classification,
                "reason": reason,
                "evidence_target": evidence_target,
                "report": asdict(report),
                "repeat_report": asdict(repeat_report),
                "board_evidence": json.loads(board_evidence) if board_evidence else None,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return report.passed and (evidence_target == "first-hit" or repeat_report.passed)


def _settings() -> Settings:
    settings = Settings(executor="fast_sim", executors="fast_sim")
    try:
        settings.require_qwen_realtime()
        settings.require_api_key()
        settings.require_tavily_api_key()
    except ConfigurationError as exc:
        raise HarnessInvalid(f"prerequisite_missing:{exc}") from exc
    return settings


def _synthesize_request_pcm(text: str) -> bytes:
    say = shutil.which("say")
    ffmpeg = shutil.which("ffmpeg")
    if say is None or ffmpeg is None:
        raise HarnessInvalid("synthetic_audio_tool_missing")
    with tempfile.TemporaryDirectory(prefix="nova-watch-audio-") as directory:
        root = Path(directory)
        aiff_path = root / "request.aiff"
        pcm_path = root / "request.pcm"
        try:
            subprocess.run(
                [say, "-v", "Tingting", "-o", str(aiff_path), text],
                check=True,
                capture_output=True,
            )
            subprocess.run(
                [
                    ffmpeg,
                    "-nostdin",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(aiff_path),
                    "-f",
                    "s16le",
                    "-acodec",
                    "pcm_s16le",
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    str(pcm_path),
                ],
                check=True,
                capture_output=True,
            )
        except (OSError, subprocess.CalledProcessError) as exc:
            raise HarnessInvalid("synthetic_audio_failed") from exc
        pcm = pcm_path.read_bytes()
    if not pcm or len(pcm) % 2:
        raise HarnessInvalid("synthetic_audio_invalid")
    return pcm


async def _stream_synthetic_audio(
    service: Any,
    pcm: bytes,
    *,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> None:
    if not pcm or len(pcm) % 2:
        raise HarnessInvalid("synthetic_audio_invalid")
    chunks = [pcm[offset : offset + 3_200] for offset in range(0, len(pcm), 3_200)]
    chunks.extend([b"\x00" * 3_200] * 10)
    for chunk in chunks:
        await service.send_audio(chunk)
        await sleep(len(chunk) / 32_000)


async def _wait_for_camera_frame(
    source: Any,
    *,
    timeout: float = 10.0,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> Any:
    async with asyncio.timeout(timeout):
        while True:
            frame = await source.snapshot()
            if frame is not None:
                return frame
            await sleep(0.05)


async def _wait_for_tool_acceptance(
    service: Any,
    *,
    existing: frozenset[tuple[int, str]],
    executor: str,
    op: str,
    timeout: float = 60.0,
) -> Any:
    async with asyncio.timeout(timeout):
        while True:
            for snapshot in service.tool_call_acceptances():
                key = (snapshot.session_epoch, snapshot.call_id)
                if key in existing:
                    continue
                acceptance = snapshot.acceptance
                if acceptance.accepted and acceptance.executor == executor and acceptance.op == op:
                    return snapshot
            if service.stopped:
                raise HarnessInvalid("provider_stopped")
            await asyncio.sleep(0.05)


async def _wait_for_delegate_handoff(
    results: dict[str, tuple[str, dict[str, Any]]],
    delegate_id: str,
    *,
    timeout: float,
) -> tuple[str, dict[str, Any]]:
    async with asyncio.timeout(timeout):
        while delegate_id not in results:
            await asyncio.sleep(0.05)
    return results[delegate_id]


async def _wait_for_evidence_target(
    renderer: Renderer,
    event_ids: list[str],
    *,
    evidence_target: EvidenceTarget,
    timeout: float,
) -> None:
    required_hits = 1 if evidence_target == "first-hit" else 2
    async with asyncio.timeout(timeout):
        while len(event_ids) < required_hits or not set(event_ids[:required_hits]).issubset(
            renderer.delivered_event_ids
        ):
            await asyncio.sleep(0.05)


def _stop_closed_monitor(
    *,
    handoff_results: dict[str, tuple[str, dict[str, Any]]],
    start_delegate_id: str,
    stop_delegate_id: str,
) -> bool:
    start_result = handoff_results.get(start_delegate_id)
    stop_result = handoff_results.get(stop_delegate_id)
    if start_result is None or stop_result is None:
        return False
    stop_outcome, stop_content = stop_result
    _, start_content = start_result
    return (
        stop_outcome == "ok"
        and stop_content.get("stopped") is True
        and start_content.get("state") == "stopped"
    )


def _scenario_provider_tools(tools: CompiledTools, mode: str) -> CompiledTools:
    names = {f"{mode}__start", f"{mode}__stop", f"{mode}__status"}
    schemas: list[dict[str, Any]] = []
    for schema in tools.schemas:
        function = schema.get("function")
        if not isinstance(function, dict) or function.get("name") not in names:
            continue
        projected = copy.deepcopy(schema)
        parameters = projected["function"]["parameters"]
        parameters["properties"].pop("origin_ref", None)
        required = [name for name in parameters.get("required", ()) if name != "origin_ref"]
        if required:
            parameters["required"] = required
        else:
            parameters.pop("required", None)
        schemas.append(projected)
    if len(schemas) != len(names):
        raise HarnessInvalid("scenario_tools_missing")
    return CompiledTools(schemas=tuple(schemas), bindings=tools.bindings)


async def _run(args: argparse.Namespace, recorder: Recorder) -> bool:
    renderer = Renderer(recorder)
    final_captions: list[tuple[str, str]] = []

    def capture_caption(caption: Any) -> None:
        if caption.final and caption.text:
            final_captions.append((caption.role, caption.text))

    settings = _settings()
    _, _, _, realtime_key = settings.require_qwen_realtime()
    recorder.protect(
        settings.require_api_key(),
        settings.require_tavily_api_key(),
        realtime_key,
    )
    assembly = build_qwen_realtime_assembly(
        settings,
        sink=NullSink(),
        camera_source="file" if args.video_file is not None else "local",
        camera_index=args.camera_index,
        camera_file=args.video_file,
        on_audio_frame=renderer.on_frame,
        on_audio_clear=renderer.on_clear,
        on_audio_alert=renderer.on_alert,
        on_audio_terminal=renderer.on_terminal,
        on_delivery=renderer.on_delivery,
        on_caption=capture_caption,
        provider_tool_view=lambda tools: _scenario_provider_tools(tools, args.mode),
    )
    renderer.service = assembly.service
    delegate_id: str | None = None
    hit_event_ids: list[str] = []
    handoff_results: dict[str, tuple[str, dict[str, Any]]] = {}
    status_observed = asyncio.Event()
    frames = RecordingFrames(assembly.core.frame_source)
    adapter = assembly.runtime.executors[args.mode]
    adapter.configure_observation_ports(
        source=frames,
        gateway=RecordingGateway(
            assembly.core.gateway,
            frames,
            recorder,
            lambda: delegate_id,
            args.condition,
            release=status_observed,
            prepare_after_release=(
                assembly.core.frame_source.restart if args.video_file is not None else None
            ),
        ),
    )
    renderer.expect_hit_delivery(
        is_correlated=lambda response_id: bool(
            set(hit_event_ids).intersection(renderer.response_event_ids.get(response_id, ()))
        ),
    )

    def observe(event: Event) -> None:
        if isinstance(event, ObservationEvent) and event.channel == args.mode:
            if event.delegate_id != delegate_id:
                return
            hit = event.content.get("hit") is True
            event_id = f"observation:{event.delegate_id}:{event.seq}" if hit else ""
            if hit:
                hit_event_ids.append(event_id)
            recorder.add(
                "watch.observation",
                {
                    "delegate_id": event.delegate_id,
                    "executor": args.mode,
                    "event_id": event_id,
                    "hit": hit,
                    "state": event.content.get("state"),
                    "hit_count": event.content.get("hit_count"),
                    "reset_count": event.content.get("reset_count"),
                },
            )
            if hit:
                observation = event.content.get("observation")
                if isinstance(observation, str):
                    renderer.observation = observation
            return
        if not isinstance(event, HandoffEvent) or event.channel != args.mode:
            return
        handoff_results[event.delegate_id] = (event.outcome, dict(event.content))
        delegate = assembly.runtime.delegates.find(event.delegate_id)
        op = None if delegate is None else delegate.op
        if op == "status":
            state = event.content.get("state")
            recorder.add(
                "status.sync",
                {
                    "executor": args.mode,
                    "sync_result": True,
                    "state": state,
                },
            )
            if state in {"armed", "cooling", "waiting_reset"}:
                status_observed.set()
        elif op == "start" and event.delegate_id == delegate_id:
            recorder.add(
                "watch.handoff",
                {
                    "delegate_id": event.delegate_id,
                    "executor": args.mode,
                    "hit": event.content.get("hit"),
                    "outcome": event.outcome,
                    "state": event.content.get("state"),
                },
            )

    unsubscribe = assembly.runtime.observe(observe)
    try:
        await assembly.start()
        await _wait_for_camera_frame(assembly.core.frame_source)

        renderer.expect_dispatch_acknowledgement()
        existing_calls = frozenset(
            (snapshot.session_epoch, snapshot.call_id)
            for snapshot in assembly.service.tool_call_acceptances()
        )
        start_prompt = (
            f"请调用 {args.mode} 的启动工具开始摄像头条件监控。"
            f"监控条件是‘{args.condition}’，每隔 {args.interval_s:g} 秒检查一次，"
            f"持续 {args.duration_s:g} 秒。请先用一句简短的话确认会开始监控，"
            "然后执行工具；工具调用后不要重复确认。"
        )
        start_pcm = await asyncio.to_thread(_synthesize_request_pcm, start_prompt)
        await _stream_synthetic_audio(assembly.service, start_pcm)
        try:
            start_snapshot = await _wait_for_tool_acceptance(
                assembly.service,
                existing=existing_calls,
                executor=args.mode,
                op="start",
            )
        except TimeoutError as exc:
            user_text = " ".join(text for role, text in final_captions if role == "user")
            transcript_state = (
                "condition_seen" if args.condition in user_text else "condition_missing"
            )
            raise HarnessInvalid(f"qwen_start_tool_missing:{transcript_state}") from exc
        acceptance = start_snapshot.acceptance
        if (
            not acceptance.accepted
            or not acceptance.delegate_id
            or acceptance.executor != args.mode
        ):
            raise HarnessInvalid("watch_admission_failed")
        delegate_id = acceptance.delegate_id
        renderer.delegate_id = delegate_id
        recorder.add(
            "dispatch.ack",
            {"executor": args.mode, "delegate_id": delegate_id},
        )
        renderer.bind_dispatch_delegate(delegate_id, start_snapshot.provider_response_id)
        await asyncio.wait_for(
            renderer.acknowledged.wait(),
            timeout=60.0,
        )
        existing_calls = frozenset(
            (snapshot.session_epoch, snapshot.call_id)
            for snapshot in assembly.service.tool_call_acceptances()
        )
        status_prompt = (
            f"请调用 {args.mode} 的状态查询工具，查询刚才摄像头监控任务的当前状态。"
            "请执行工具，不要只回答。"
        )
        status_pcm = await asyncio.to_thread(_synthesize_request_pcm, status_prompt)
        await _stream_synthetic_audio(assembly.service, status_pcm)
        try:
            status_snapshot = await _wait_for_tool_acceptance(
                assembly.service,
                existing=existing_calls,
                executor=args.mode,
                op="status",
            )
        except TimeoutError as exc:
            raise HarnessInvalid("qwen_status_tool_missing") from exc
        status = status_snapshot.acceptance
        if not status.accepted or not status.delegate_id or not status.sync_result:
            raise HarnessInvalid("watch_status_admission_failed")
        await asyncio.wait_for(status_observed.wait(), timeout=10.0)
        evidence_target: EvidenceTarget = getattr(args, "evidence_target", "repeat")
        await _wait_for_evidence_target(
            renderer,
            hit_event_ids,
            evidence_target=evidence_target,
            timeout=args.duration_s + 60,
        )
        existing_calls = frozenset(
            (snapshot.session_epoch, snapshot.call_id)
            for snapshot in assembly.service.tool_call_acceptances()
        )
        stop_prompt = f"请调用 {args.mode} 的停止工具，停止刚才的摄像头监控任务。"
        stop_pcm = await asyncio.to_thread(_synthesize_request_pcm, stop_prompt)
        await _stream_synthetic_audio(assembly.service, stop_pcm)
        try:
            stop_snapshot = await _wait_for_tool_acceptance(
                assembly.service,
                existing=existing_calls,
                executor=args.mode,
                op="stop",
            )
        except TimeoutError as exc:
            raise HarnessInvalid("qwen_stop_tool_missing") from exc
        stop = stop_snapshot.acceptance
        if not stop.accepted or not stop.delegate_id:
            raise HarnessInvalid("watch_stop_admission_failed")
        stop_wait_timeout = min(START.deadline_budget, args.duration_s + 60.0)
        stop_deadline = asyncio.get_running_loop().time() + stop_wait_timeout
        await _wait_for_delegate_handoff(
            handoff_results,
            stop.delegate_id,
            timeout=stop_wait_timeout,
        )
        remaining = stop_deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise TimeoutError
        assert delegate_id is not None
        await _wait_for_delegate_handoff(
            handoff_results,
            delegate_id,
            timeout=remaining,
        )
        stop_outcome, stop_content = handoff_results[stop.delegate_id]
        start_outcome, start_content = handoff_results[delegate_id]
        recorder.add(
            "watch.stop",
            {
                "start_delegate_id": delegate_id,
                "stop_delegate_id": stop.delegate_id,
                "outcome": stop_outcome,
                "stopped": stop_content.get("stopped"),
                "start_state": start_content.get("state") if start_outcome == "ok" else "failed",
            },
        )
        if not _stop_closed_monitor(
            handoff_results=handoff_results,
            start_delegate_id=delegate_id,
            stop_delegate_id=stop.delegate_id,
        ):
            raise HarnessInvalid("watch_stop_not_effective")
        recorder.board_message = sanitize_repeat_board_message(
            memory_board_message(
                "watch-alert-live",
                assembly.runtime.memory,
            ),
            args.mode,
        )
        first_edge_report = evaluate_watch_alert(
            recorder.records,
            backend="live",
            minimum_pre_hit_misses=2 if args.video_file is not None else 0,
        )
        repeat_report = evaluate_repeat_watch_alert(
            recorder.records,
            board_message=recorder.board_message,
            backend="live",
        )
        return first_edge_report.passed and (evidence_target == "first-hit" or repeat_report.passed)
    finally:
        unsubscribe()
        await assembly.stop()


async def _main(args: argparse.Namespace) -> int:
    recorder = Recorder()
    minimum_pre_hit_misses = 2 if getattr(args, "video_file", None) is not None else 0
    evidence_target: EvidenceTarget = getattr(args, "evidence_target", "repeat")
    try:
        passed = await _run(args, recorder)
    except asyncio.CancelledError:
        reason = "CancelledError"
        _write(
            args.artifacts,
            recorder,
            "harness_invalid",
            reason,
            minimum_pre_hit_misses=minimum_pre_hit_misses,
            evidence_target=evidence_target,
        )
        print(f"[watch-alert] harness_invalid: {reason}")
        return EXIT_HARNESS_INVALID
    except (HarnessInvalid, ConfigurationError) as exc:
        _write(
            args.artifacts,
            recorder,
            "harness_invalid",
            str(exc),
            minimum_pre_hit_misses=minimum_pre_hit_misses,
            evidence_target=evidence_target,
        )
        print(f"[watch-alert] harness_invalid: {exc}")
        return EXIT_HARNESS_INVALID
    except (TimeoutError, OSError) as exc:
        _write(
            args.artifacts,
            recorder,
            "harness_invalid",
            type(exc).__name__,
            minimum_pre_hit_misses=minimum_pre_hit_misses,
            evidence_target=evidence_target,
        )
        print(f"[watch-alert] harness_invalid: {type(exc).__name__}")
        return EXIT_HARNESS_INVALID
    except Exception as exc:  # noqa: BLE001 - external failures must be credential-redacted
        reason = type(exc).__name__
        _write(
            args.artifacts,
            recorder,
            "harness_invalid",
            reason,
            minimum_pre_hit_misses=minimum_pre_hit_misses,
            evidence_target=evidence_target,
        )
        print(f"[watch-alert] harness_invalid: {reason}")
        return EXIT_HARNESS_INVALID
    _write(
        args.artifacts,
        recorder,
        "pass" if passed else "fail",
        None,
        minimum_pre_hit_misses=minimum_pre_hit_misses,
        evidence_target=evidence_target,
    )
    return EXIT_PASS if passed else EXIT_FAIL


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=f"Run live {SCENARIO_ID}.")
    parser.add_argument("--condition", default="水杯")
    parser.add_argument("--mode", choices=("watch", "guard"), default="watch")
    parser.add_argument("--camera-index", type=int, default=0)
    parser.add_argument("--video-file", type=Path)
    parser.add_argument("--interval-s", type=float, default=5.0)
    parser.add_argument("--duration-s", type=float, default=300.0)
    parser.add_argument(
        "--evidence-target",
        choices=("repeat", "first-hit"),
        default="repeat",
    )
    parser.add_argument("--artifacts", type=Path, required=True)
    return parser


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not 2 <= args.interval_s <= 30:
        parser.error("--interval-s must be between 2 and 30")
    if not 30 <= args.duration_s <= 1800:
        parser.error("--duration-s must be between 30 and 1800")
    if args.video_file is not None and (
        not args.video_file.is_absolute() or not args.video_file.is_file()
    ):
        parser.error("--video-file must be an absolute existing regular file")
    if args.video_file is not None and args.mode != "guard":
        parser.error("--video-file only supports --mode guard")
    return args


def main() -> int:
    return asyncio.run(_main(parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
