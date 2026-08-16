#!/usr/bin/env python3
"""Run the explicitly-invoked live `qwen-weather-same-turn.v1` scenario.

Authority: docs/superpowers/specs/2026-08-06-realtime-weather-live-e2e-design.md.

This is the live twin of tests/test_e2e_weather_same_turn.py: the same scenario
records, the same evaluator, Gate 6 enabled. It drives the production Qwen realtime
adapter and the production Tavily transport through
``nova_audio_agent.assembly.build_qwen_realtime_assembly``.

Required environment (all failures here are ``harness_invalid``, never a product
verdict):

- a Qwen/DashScope credential — ``DASHSCOPE_API_KEY``, or ``NOVA_AUDIO_AGENT_MODEL_API_KEY``
  when the configured base URL is DashScope;
- ``TAVILY_API_KEY``;
- a working Codex binary and credential. The realtime assembly hard-requires
  ``executor=codex`` (D19 admits exactly one non-readonly executor), so the session
  cannot start without it **even though this scenario never calls a codex__* tool**.
  A missing Codex credential is ``harness_invalid`` and is reported as such rather
  than surfacing as a misleading session-startup error;
- ``say`` and ``ffmpeg`` for user-turn synthesis;
- outbound access to both provider endpoints.

Exit codes: 0 pass, 1 fail (harness valid, a gate failed), 2 harness_invalid.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import shutil
import subprocess
import tempfile
from collections.abc import AsyncIterator, Mapping, Sequence
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from nova_audio_agent.assembly import build_qwen_realtime_assembly
from nova_audio_agent.clock import RealClock
from nova_audio_agent.config import ConfigurationError, Settings
from nova_audio_agent.evals.weather_same_turn import (
    SCENARIO_ID,
    USER_TURN,
    ScenarioRecorder,
    ScenarioReport,
    ScenarioTimeout,
    build_report_mapping,
    evaluate_weather_same_turn,
)
from nova_audio_agent.events import Event, HandoffEvent
from nova_audio_agent.realtime.bridge import ToolAcceptance
from nova_audio_agent.realtime.playback import PlaybackCompletion, PlaybackFrame
from nova_audio_agent.realtime.protocol import (
    HostContextItem,
    HostResponseIntent,
    ItemIdentity,
    RealtimeFrontBrainEvent,
    ResponseAudioDelta,
    ResponseStarted,
    ResponseTerminal,
    ResponseTranscriptFinal,
    ToolCallReady,
)
from nova_audio_agent.speech import RecordingSink

EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_HARNESS_INVALID = 2

MAX_ATTEMPTS = 3
UPLINK_SAMPLE_RATE = 16_000
UPLINK_CHUNK_BYTES = 1280  # 40 ms of 16 kHz mono PCM16
TRAILING_SILENCE_CHUNKS = 25  # ~1 s, so provider VAD closes the user turn
PLAYBACK_BYTES_PER_MS = 48  # 24 kHz mono PCM16 downlink
TRANSCRIPT_GRACE_S = 5.0

CODEX_CREDENTIAL_NOTE = (
    "the realtime assembly hard-requires executor=codex (D19: exactly one non-readonly "
    "executor), so a working Codex binary and credential must exist even though this "
    "scenario never calls a codex__* tool"
)


def _artifact_transcript(text: str) -> str:
    """Keep delivered speech readable while preserving the recorder's no-controls boundary."""
    return " ".join(text.split())


class HarnessInvalid(RuntimeError):
    """Prerequisites or external provider operation prevented a product verdict."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        self.records: tuple[Mapping[str, Any], ...] = ()
        super().__init__(reason)


# ----------------------------------------------------------------------------------
# Prerequisites and user-turn synthesis
# ----------------------------------------------------------------------------------


def preflight(fallback_codex_workspace: Path) -> tuple[Settings, str, str, str]:
    """Return (settings, endpoint_url, model, voice) or raise a named HarnessInvalid."""
    for tool in ("say", "ffmpeg"):
        if shutil.which(tool) is None:
            raise HarnessInvalid(f"missing_tool:{tool} (required to synthesize the user turn)")
    try:
        settings = Settings(executor="codex")
        if settings.codex_workspace is None:
            # This scenario never calls a codex__* tool, but the realtime assembly
            # hard-requires an executor=codex wiring (D19), and require_codex() demands
            # an existing workspace directory. A disposable empty directory satisfies
            # the prerequisite without handing the scenario a coding surface. An
            # operator-configured NOVA_AUDIO_AGENT_CODEX_WORKSPACE always wins.
            fallback_codex_workspace.mkdir(parents=True, exist_ok=True)
            settings = Settings(executor="codex", codex_workspace=fallback_codex_workspace)
    except Exception as exc:  # noqa: BLE001 - any settings failure is a harness problem
        raise HarnessInvalid(f"settings_invalid:{type(exc).__name__}") from exc
    try:
        url, model, voice, _api_key = settings.require_qwen_realtime()
    except ConfigurationError as exc:
        raise HarnessInvalid(f"qwen_credential_missing:{exc}") from exc
    try:
        settings.require_tavily_api_key()
    except ConfigurationError as exc:
        raise HarnessInvalid(f"tavily_credential_missing:{exc}") from exc
    try:
        settings.require_codex()
    except ConfigurationError as exc:
        raise HarnessInvalid(f"codex_prerequisite_missing:{exc} — {CODEX_CREDENTIAL_NOTE}") from exc
    return settings, url, model, voice


def synthesize_user_turn(directory: Path, *, voice: str = "Tingting") -> bytes:
    """Render the fixed user turn to 16 kHz mono PCM16.

    Same ``say`` -> ``ffmpeg`` pipeline as ``scripts/realtime_probe/fixtures.py``;
    inlined here because that helper only renders the probe's own fixed text set.
    """
    say = shutil.which("say")
    ffmpeg = shutil.which("ffmpeg")
    if say is None or ffmpeg is None:  # pragma: no cover - preflight already checked
        raise HarnessInvalid("missing_tool:say_or_ffmpeg")
    aiff_path = directory / "user_turn.aiff"
    pcm_path = directory / "user_turn.pcm"
    try:
        subprocess.run(
            [say, "-v", voice, "-o", str(aiff_path), USER_TURN],
            check=True,
            capture_output=True,
            text=True,
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
                str(UPLINK_SAMPLE_RATE),
                "-ac",
                "1",
                str(pcm_path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        raise HarnessInvalid(f"user_turn_synthesis_failed:{exc.returncode}") from exc
    payload = pcm_path.read_bytes()
    if not payload or len(payload) % 2:
        raise HarnessInvalid("user_turn_synthesis_produced_unusable_pcm")
    return payload


# ----------------------------------------------------------------------------------
# Recording hooks
# ----------------------------------------------------------------------------------


class LiveRecording:
    """Renderer acknowledgements plus the scenario's normalized record stream.

    The software renderer half is not optional: ``RealtimeService`` treats renderer
    acknowledgements as delivery truth (R98/R99). Without ``playback_started`` /
    ``playback_done`` the Floor is never released and host delivery starves.
    """

    def __init__(self, recorder: ScenarioRecorder) -> None:
        self.recorder = recorder
        self.service: Any | None = None
        self.origin_response_ids: set[str] = set()
        self.continuation_response_ids: set[str] = set()
        self.codex_states: list[str] = []
        self._pending_continuation = False
        self._generation_bytes: dict[tuple[str, int], int] = {}
        self._started_generations: set[tuple[str, int]] = set()
        self._transcript_recorded = False
        self._continuation_transcripts: list[str] = []

    # -- renderer -------------------------------------------------------------

    def on_audio_frame(self, frame: PlaybackFrame) -> None:
        key = (frame.utterance_id, frame.generation_epoch)
        self._generation_bytes[key] = self._generation_bytes.get(key, 0) + len(frame.pcm)
        if key not in self._started_generations:
            self._started_generations.add(key)
            self._defer(lambda: self._ack_started(key))

    def on_audio_terminal(self, utterance_id: str, generation_epoch: int) -> None:
        key = (utterance_id, generation_epoch)
        self._defer(lambda: self._ack_done(key))

    def on_audio_clear(self, utterance_id: str, generation_epoch: int) -> None:
        key = (utterance_id, generation_epoch)
        self._defer(lambda: self._ack_cleared(key))

    def on_delivery(self, completion: PlaybackCompletion) -> None:
        if completion.response_id not in self.continuation_response_ids:
            return
        text = _artifact_transcript(completion.text)
        if not text:
            return
        # Delivery is renderer-acknowledged truth (R98 T1); captions are speculative.
        self.recorder.record("answer.transcript", {"text": text})
        self._transcript_recorded = True

    def on_codex_state(self, state: str) -> None:
        self.codex_states.append(state)

    # -- provider -------------------------------------------------------------

    def observe_provider_event(self, event: RealtimeFrontBrainEvent) -> None:
        if isinstance(event, ResponseStarted):
            if self._pending_continuation:
                self._pending_continuation = False
                self.continuation_response_ids.add(event.response_id)
                self.recorder.record("continuation.created", {"response_id": event.response_id})
            else:
                self.origin_response_ids.add(event.response_id)
        elif isinstance(event, ToolCallReady):
            arguments = event.arguments if isinstance(event.arguments, dict) else {}
            self.recorder.record(
                "tool.call",
                {
                    "call_id": event.call_id,
                    "name": event.name,
                    "query": arguments.get("query"),
                    "k": arguments.get("k"),
                },
            )
        elif isinstance(event, ResponseAudioDelta):
            if event.response_id in self.continuation_response_ids:
                self.recorder.record(
                    "audio.delta",
                    {"response_id": event.response_id, "bytes": len(event.pcm)},
                )
        elif isinstance(event, ResponseTranscriptFinal):
            if event.response_id in self.continuation_response_ids and event.text.strip():
                self._continuation_transcripts.append(event.text)
        elif isinstance(event, ResponseTerminal):
            kind = (
                "continuation.terminal"
                if event.response_id in self.continuation_response_ids
                else "origin.terminal"
            )
            self.recorder.record(
                kind,
                {"response_id": event.response_id, "status": event.status},
            )

    def observe_injection(self, item: HostContextItem) -> None:
        if item.kind == "tool_output" and item.call_id is not None:
            self.recorder.record(
                "tool.output",
                {"call_id": item.call_id, "content": item.content},
            )

    def observe_response_request(self, intent: HostResponseIntent) -> None:
        if intent.kind == "tool_result":
            self._pending_continuation = True

    def observe_acceptance(self, call: ToolCallReady, acceptance: ToolAcceptance) -> None:
        try:
            state = json.loads(acceptance.host_item.content).get("state")
        except (json.JSONDecodeError, AttributeError):
            state = None
        self.recorder.record(
            "tool.accepted",
            {
                "call_id": call.call_id,
                "delegate_id": acceptance.delegate_id,
                "sync_result": acceptance.sync_result,
                "state": state,
                "code": acceptance.code,
            },
        )

    def observe_runtime_event(self, event: Event) -> None:
        if isinstance(event, HandoffEvent) and event.channel == "search":
            content = event.content if isinstance(event.content, Mapping) else {}
            results = content.get("results")
            self.recorder.record(
                "search.handoff",
                {
                    "delegate_id": event.delegate_id,
                    "outcome": event.outcome,
                    "result_count": len(results) if isinstance(results, list) else 0,
                },
            )

    def finish(self) -> None:
        """Fall back to the provider transcript when no delivery ack carried text."""
        if self._transcript_recorded or not self._continuation_transcripts:
            return
        text = _artifact_transcript(self._continuation_transcripts[-1])
        if not text:
            return
        self.recorder.record("answer.transcript", {"text": text})
        self._transcript_recorded = True

    # -- internals ------------------------------------------------------------

    def _defer(self, action: Any) -> None:
        # A real renderer acknowledges asynchronously; deferring keeps this harness
        # out of the service's own event handling stack.
        try:
            asyncio.get_running_loop().call_soon(action)
        except RuntimeError:  # pragma: no cover - no loop during teardown
            action()

    def _played_ms(self, key: tuple[str, int]) -> int:
        return self._generation_bytes.get(key, 0) // PLAYBACK_BYTES_PER_MS

    def _ack_started(self, key: tuple[str, int]) -> None:
        if self.service is not None:
            self.service.playback_started(key[0], key[1])

    def _ack_done(self, key: tuple[str, int]) -> None:
        if self.service is not None:
            self.service.playback_done(key[0], key[1], self._played_ms(key))

    def _ack_cleared(self, key: tuple[str, int]) -> None:
        if self.service is not None:
            self.service.playback_cleared(key[0], key[1], self._played_ms(key))


class _RecordingBridge:
    """Forward every call to the real bridge, recording only the scenario allowlist."""

    def __init__(self, inner: Any, recording: LiveRecording) -> None:
        self._inner = inner
        self._recording = recording

    async def accept_user_transcript(self, text: str) -> object:
        return await self._inner.accept_user_transcript(text)

    async def accept_tool_call(self, call: ToolCallReady) -> ToolAcceptance:
        acceptance = await self._inner.accept_tool_call(call)
        self._recording.observe_acceptance(call, acceptance)
        return acceptance


def install_recorders(assembly: Any, recording: LiveRecording) -> None:
    """Attach read-only recording seams to the already-built production stack."""
    assembly.runtime.observe(recording.observe_runtime_event)

    provider = assembly.provider
    original_events = provider.events
    original_inject = provider.inject_host_item
    original_create = provider.create_response

    async def events() -> AsyncIterator[RealtimeFrontBrainEvent]:
        async for event in original_events():
            recording.observe_provider_event(event)
            yield event

    async def inject_host_item(item: HostContextItem) -> ItemIdentity:
        identity = await original_inject(item)
        recording.observe_injection(item)
        return identity

    async def create_response(intent: HostResponseIntent) -> None:
        await original_create(intent)
        recording.observe_response_request(intent)

    provider.events = events
    provider.inject_host_item = inject_host_item
    provider.create_response = create_response

    # The single private reach in this harness. `ToolAcceptance.delegate_id` and
    # `sync_result` are the only evidence that correlates the tool call to the Search
    # Handoff (Gate 2), and no assembly callback exposes them. The wrapper forwards
    # every call unchanged; it adds no behavior.
    assembly.service._bridge = _RecordingBridge(assembly.service._bridge, recording)


# ----------------------------------------------------------------------------------
# One attempt
# ----------------------------------------------------------------------------------


async def send_user_turn(service: Any, pcm: bytes) -> None:
    chunks = [
        pcm[offset : offset + UPLINK_CHUNK_BYTES]
        for offset in range(0, len(pcm), UPLINK_CHUNK_BYTES)
    ]
    chunks.extend([b"\x00" * UPLINK_CHUNK_BYTES] * TRAILING_SILENCE_CHUNKS)
    for chunk in chunks:
        await service.send_audio(chunk)
        await asyncio.sleep(len(chunk) / (UPLINK_SAMPLE_RATE * 2))


async def await_answer(service: Any, recorder: ScenarioRecorder, *, timeout: float) -> None:
    """Wait for the continuation terminal, or classify a dead session.

    A provider that never reaches a terminal response is a **semantic failure** per
    the design doc, so a timeout returns normally and lets the gates name the stage
    that stalled. A session that stops underneath us is a provider outage.
    """
    waiter = asyncio.create_task(recorder.wait_for("continuation.terminal", timeout=timeout))
    stopped = asyncio.create_task(service.wait_stopped())
    done, pending = await asyncio.wait({waiter, stopped}, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
    if waiter in done:
        failure = waiter.exception()
        if failure is not None and not isinstance(failure, ScenarioTimeout):
            raise failure
    elif stopped in done:
        raise HarnessInvalid("realtime_session_stopped_before_answer")
    with contextlib.suppress(ScenarioTimeout):
        await recorder.wait_for("answer.transcript", timeout=TRANSCRIPT_GRACE_S)


async def run_attempt(
    settings: Settings,
    *,
    pcm: bytes,
    timeout: float,
) -> tuple[ScenarioRecorder, ScenarioReport]:
    recorder = ScenarioRecorder(clock=RealClock())
    recording = LiveRecording(recorder)
    try:
        assembly = build_qwen_realtime_assembly(
            settings,
            sink=RecordingSink(RealClock()),
            on_audio_frame=recording.on_audio_frame,
            on_audio_clear=recording.on_audio_clear,
            on_audio_terminal=recording.on_audio_terminal,
            on_delivery=recording.on_delivery,
            on_codex_state=recording.on_codex_state,
        )
    except ConfigurationError as exc:
        raise HarnessInvalid(f"assembly_configuration:{exc} — {CODEX_CREDENTIAL_NOTE}") from exc
    # This scenario never dispatches Codex, so spawning and preflighting an
    # app-server process at startup would only add failure surface (R102 makes
    # prewarm an explicit switch).
    assembly.codex_prewarm = False
    recording.service = assembly.service
    install_recorders(assembly, recording)
    recorder.record("user.turn", {"text": USER_TURN})

    try:
        await assembly.start()
    except HarnessInvalid:
        raise
    except Exception as exc:  # noqa: BLE001 - startup failures are harness problems
        failure = HarnessInvalid(f"session_startup_failed:{type(exc).__name__}")
        failure.records = recorder.records
        raise failure from exc

    try:
        await send_user_turn(assembly.service, pcm)
        await await_answer(assembly.service, recorder, timeout=timeout)
    except HarnessInvalid as failure:
        failure.records = recorder.records
        raise
    finally:
        with contextlib.suppress(Exception):
            await assembly.stop()

    recording.finish()
    return recorder, evaluate_weather_same_turn(recorder.records, live=True)


# ----------------------------------------------------------------------------------
# Artifacts
# ----------------------------------------------------------------------------------


def write_artifacts(
    directory: Path,
    *,
    manifest: Mapping[str, Any],
    records: Sequence[Mapping[str, Any]],
    report: ScenarioReport | None,
    classification: str,
    reason: str | None,
) -> None:
    """Write one immutable attempt directory. Never overwrites an existing attempt."""
    directory.mkdir(parents=True, exist_ok=False)
    _write_json(directory / "manifest.json", {**dict(manifest), "classification": classification})
    with (directory / "events.ndjson").open("w", encoding="utf-8") as stream:
        for record in records:
            stream.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
    if report is None:
        payload: dict[str, Any] = {
            "scenario_id": SCENARIO_ID,
            "manifest": dict(manifest),
            "passed": False,
            "classification": classification,
            "reason": reason,
            "event_count": len(records),
        }
    else:
        payload = build_report_mapping(report, records=records, manifest=manifest)
        payload["classification"] = classification
        payload["reason"] = reason
    _write_json(directory / "report.json", payload)


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def print_summary(report: ScenarioReport) -> None:
    print(f"[weather-same-turn] scenario={SCENARIO_ID} passed={report.passed}")
    for gate in report.gates:
        print(f"[weather-same-turn]   {gate.name}: {'pass' if gate.passed else 'FAIL'}")
        for finding in gate.findings:
            print(
                f"[weather-same-turn]     - {finding.code} @{finding.event_ref}: {finding.detail}"
            )
    if not report.passed:
        print(f"[weather-same-turn] first violated gate: {report.first_failed_gate}")
    print(
        "[weather-same-turn] metrics="
        f"{json.dumps(dict(report.metrics), ensure_ascii=False, sort_keys=True)}"
    )


# ----------------------------------------------------------------------------------
# Entry point
# ----------------------------------------------------------------------------------


async def _main(args: argparse.Namespace) -> int:
    output: Path = args.output
    output.mkdir(parents=True, exist_ok=True)
    last_reason: str | None = None
    with tempfile.TemporaryDirectory(prefix="weather-same-turn-") as staging:
        try:
            settings, url, model, voice = preflight(Path(staging) / "codex-workspace")
        except HarnessInvalid as failure:
            _write_json(
                output / "preflight.json",
                {
                    "scenario_id": SCENARIO_ID,
                    "backend": "live",
                    "classification": "harness_invalid",
                    "reason": failure.reason,
                },
            )
            print(f"[weather-same-turn] harness_invalid: {failure.reason}")
            return EXIT_HARNESS_INVALID

        endpoint_host = urlsplit(url).hostname or ""
        try:
            pcm = synthesize_user_turn(Path(staging))
        except HarnessInvalid as failure:
            _write_json(
                output / "preflight.json",
                {
                    "scenario_id": SCENARIO_ID,
                    "backend": "live",
                    "classification": "harness_invalid",
                    "reason": failure.reason,
                },
            )
            print(f"[weather-same-turn] harness_invalid: {failure.reason}")
            return EXIT_HARNESS_INVALID

        for attempt in range(1, MAX_ATTEMPTS + 1):
            manifest = {
                "scenario_id": SCENARIO_ID,
                "backend": "live",
                "model": model,
                "voice": voice,
                "endpoint_host": endpoint_host,
                "attempt": attempt,
                "max_attempts": MAX_ATTEMPTS,
                "user_turn": USER_TURN,
                "uplink_pcm_bytes": len(pcm),
            }
            directory = output / f"attempt-{attempt:02d}"
            try:
                recorder, report = await run_attempt(settings, pcm=pcm, timeout=args.timeout)
            except HarnessInvalid as failure:
                last_reason = failure.reason
                records: Sequence[Mapping[str, Any]] = failure.records
            except Exception as failure:  # noqa: BLE001
                # An exception escaping the harness is never a product gate verdict.
                # Classify it, keep the partial event stream, and let the operator see
                # the traceback instead of losing the attempt entirely.
                last_reason = f"unexpected_harness_error:{type(failure).__name__}: {failure}"
                records = getattr(failure, "records", ())
            else:
                # Only harness_invalid may be retried: the first valid semantic result
                # is retained and stops the run.
                write_artifacts(
                    directory,
                    manifest=manifest,
                    records=recorder.records,
                    report=report,
                    classification="pass" if report.passed else "fail",
                    reason=None,
                )
                print_summary(report)
                return EXIT_PASS if report.passed else EXIT_FAIL
            write_artifacts(
                directory,
                manifest=manifest,
                records=records,
                report=None,
                classification="harness_invalid",
                reason=last_reason,
            )
            print(f"[weather-same-turn] attempt {attempt} harness_invalid: {last_reason}")

    print(f"[weather-same-turn] harness_invalid after {MAX_ATTEMPTS} attempts: {last_reason}")
    return EXIT_HARNESS_INVALID


def main() -> int:
    parser = argparse.ArgumentParser(description=f"Run the live {SCENARIO_ID} scenario.")
    parser.add_argument("--output", type=Path, required=True, help="artifact directory")
    parser.add_argument("--timeout", type=float, default=180.0)
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    try:
        return asyncio.run(_main(args))
    except KeyboardInterrupt:  # pragma: no cover - operator abort
        print("[weather-same-turn] harness_invalid: interrupted")
        return EXIT_HARNESS_INVALID


if __name__ == "__main__":
    raise SystemExit(main())
