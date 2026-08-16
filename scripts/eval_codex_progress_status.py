#!/usr/bin/env python3
"""Run the opt-in live ``qwen-codex-live-progress-status.v1`` scenario.

Authority: ``docs/superpowers/specs/2026-08-06-codex-live-progress-status-e2e-design.md``.

This is the live twin of ``tests/test_e2e_codex_progress_status.py``: a real Codex App
Server process, a real Qwen-Audio realtime session, the contracted Tetris workspace,
and ``RealClock``. Both backends are judged by the same
:func:`evaluate_codex_progress_status`, so a green CI run and a green live run mean the
same thing.

Three things decide whether this harness observes anything at all:

* **A software renderer is mandatory.** ``RealtimeService`` treats renderer
  acknowledgements as delivery truth (R98/R99), and ``flush_host_items`` only runs while
  the session is foreground-idle and the floor is idle. Without ``playback_started`` /
  ``playback_done`` acks the floor never releases, the progress host fact is never
  injected, and a perfectly healthy run would be misreported as ``fixture_too_fast``.
* **The status question is event-triggered, never timed.** It is sent only after an
  *informative* Surrogate-selected summary's host fact is injection-confirmed and its
  response has reached a terminal delivery. No sleep guesses when useful progress
  might exist.
* **The workspace verdict is the harness's own.** Codex saying "completed" is a protocol
  outcome, not goal verification. Hashes and an independently executed
  ``python -m unittest`` decide Gate 6.

Exit codes: ``0`` pass, ``1`` fail, ``2`` harness_invalid.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import shutil
import subprocess
import tempfile
from collections import deque
from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from nova_audio_agent.assembly import build_qwen_realtime_assembly
from nova_audio_agent.config import ConfigurationError, Settings
from nova_audio_agent.evals.codex_progress_status import (
    CODEX_RUN_TOOL_NAME,
    SCENARIO_ID,
    STATUS_QUESTION,
    ScenarioRecorder,
    ScenarioTimeout,
    build_report_mapping,
    evaluate_codex_progress_status,
    failure_reason,
    is_informative,
)
from nova_audio_agent.evals.event_report_fixture import (
    changed_paths,
    workspace_hashes,
)
from nova_audio_agent.evals.tetris_artifact import (
    check_tetris_artifact,
    create_contracted_workspace,
)
from nova_audio_agent.events import HandoffEvent, ProgressEvent
from nova_audio_agent.speech import RecordingSink

EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_HARNESS_INVALID = 2

MAX_ATTEMPTS = 3
SCENARIO_VERSION = 2

WORK_ORDER = (
    "请按照工作区的 TASK_CONTRACT.md 写完一个可运行的俄罗斯方块游戏。"
    "不要只总结合同；必须实际创建 tetris_game 包、完成代码，并运行合同里的 smoke 和导入检查，"
    "直到通过后再结束。过程中请简要说明进度。"
)

REQUIRED_TETRIS_GATES = frozenset(
    {"build_and_start", "core_tetris_behavior", "steered_speed_control", "workspace_hygiene"}
)

#: 40 ms of 16 kHz mono PCM16, the shape the realtime input buffer expects.
INPUT_SAMPLE_RATE = 16_000
CHUNK_BYTES = 1_280
CHUNK_SECONDS = 0.04
TRAILING_SILENCE_CHUNKS = 25
STATUS_TRAILING_SILENCE_CHUNKS = 75

#: 24 kHz mono PCM16 output: 48 bytes per millisecond of speech.
OUTPUT_BYTES_PER_MS = 48

SPEECH_VOICE = "Tingting"


def _artifact_transcript(text: str) -> str:
    """Keep delivered speech readable while preserving the recorder's no-controls boundary."""
    return " ".join(text.split())


class HarnessInvalid(RuntimeError):
    """The intended observation window could not be established."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


# ---------------------------------------------------------------------------
# Audio input
# ---------------------------------------------------------------------------


def synthesize_pcm(text: str, destination: Path) -> bytes:
    """``say`` then ``ffmpeg``, the same path as ``scripts/realtime_probe/fixtures.py``."""
    say = shutil.which("say")
    ffmpeg = shutil.which("ffmpeg")
    if say is None:
        raise HarnessInvalid("missing_tool:say")
    if ffmpeg is None:
        raise HarnessInvalid("missing_tool:ffmpeg")
    aiff = destination.with_suffix(".aiff")
    try:
        subprocess.run(
            [say, "-v", SPEECH_VOICE, "-o", str(aiff), text],
            check=True,
            capture_output=True,
            text=True,
            timeout=120,
        )
        subprocess.run(
            [
                ffmpeg,
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
                str(INPUT_SAMPLE_RATE),
                "-ac",
                "1",
                str(destination),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (subprocess.SubprocessError, OSError) as failure:
        raise HarnessInvalid(f"speech_synthesis_failed:{type(failure).__name__}") from None
    finally:
        aiff.unlink(missing_ok=True)
    pcm = destination.read_bytes()
    if not pcm or len(pcm) % 2:
        raise HarnessInvalid("speech_synthesis_produced_unaligned_pcm")
    return pcm


# ---------------------------------------------------------------------------
# Observation
# ---------------------------------------------------------------------------


class SoftwareRenderer:
    """Acknowledge every generation without waiting out its real duration.

    The service needs renderer acks to release the floor; it does not need them to
    arrive at audio speed. ``played_ms`` is still reported honestly from the byte count
    so the session's delivery bookkeeping stays truthful.
    """

    def __init__(self) -> None:
        self.service: Any = None
        self._bytes: dict[tuple[str, int], int] = {}
        self._started: set[tuple[str, int]] = set()

    def bytes_for(self, utterance_id: str, generation_epoch: int) -> int:
        return self._bytes.get((utterance_id, generation_epoch), 0)

    def _played_ms(self, key: tuple[str, int]) -> int:
        return self._bytes.get(key, 0) // OUTPUT_BYTES_PER_MS

    def on_frame(self, frame: Any) -> None:
        key = (frame.utterance_id, frame.generation_epoch)
        if key not in self._started:
            self._started.add(key)
            self.service.playback_started(*key)
        self._bytes[key] = self._bytes.get(key, 0) + len(frame.pcm)

    def on_clear(self, utterance_id: str, generation_epoch: int) -> None:
        key = (utterance_id, generation_epoch)
        self.service.playback_cleared(utterance_id, generation_epoch, self._played_ms(key))

    def on_terminal(self, utterance_id: str, generation_epoch: int) -> None:
        key = (utterance_id, generation_epoch)
        self.service.playback_done(utterance_id, generation_epoch, self._played_ms(key))


class HostFactTelemetry:
    """Correlate an injected host fact with the provider response that speaks it.

    ``hostitem.injected`` is the production injection-confirmed signal, and the next
    ``provider.response_started`` is the response created for it. That pairing is what
    lets the harness know which delivered response was the progress announcement rather
    than guessing from ordering alone.
    """

    def __init__(self) -> None:
        self.response_event_ids: dict[str, str] = {}
        self.injected: deque[str] = deque()
        self._armed: str | None = None

    def record(self, kind: str, payload: dict[str, Any]) -> None:
        if kind == "hostitem.injected":
            event_id = payload.get("event_id")
            if isinstance(event_id, str):
                self._armed = event_id
                self.injected.append(event_id)
        elif kind == "provider.response_started":
            response_id = payload.get("response_id")
            if isinstance(response_id, str) and self._armed is not None:
                self.response_event_ids[response_id] = self._armed
                self._armed = None

    def close(self) -> None:
        return None


class RecordingProvider:
    """Record what actually entered the provider conversation, changing nothing.

    Same hot-swap posture as ``evals.live_tetris.RecordingCodexAdapter``: a delegating
    wrapper is installed after assembly, so no production module is modified and the
    recorded content is the real injected content rather than a reconstruction.
    """

    def __init__(self, inner: Any, recorder: ScenarioRecorder) -> None:
        self._inner = inner
        self._recorder = recorder

    async def connect(self, *, tools: tuple[dict[str, Any], ...]) -> Any:
        return await self._inner.connect(tools=tools)

    async def send_audio(self, pcm: bytes) -> None:
        await self._inner.send_audio(pcm)

    async def inject_host_item(self, item: Any) -> Any:
        identity = await self._inner.inject_host_item(item)
        if item.kind == "progress":
            self._recorder.record(
                "progress.fact", {"event_id": item.event_id, "content": item.content}
            )
        elif item.kind == "final":
            self._recorder.record(
                "final.fact", {"event_id": item.event_id, "content": item.content}
            )
        return identity

    async def create_response(self, intent: Any) -> None:
        await self._inner.create_response(intent)

    async def cancel_response(self, response_id: str) -> None:
        await self._inner.cancel_response(response_id)

    def events(self) -> Any:
        return self._inner.events()

    async def close(self) -> None:
        await self._inner.close()


class RecordingBridge:
    """Delegate to the real bridge and record the tool proposal plus its verdict."""

    def __init__(
        self,
        inner: Any,
        recorder: ScenarioRecorder,
        *,
        on_delegate: Callable[[str], None],
    ) -> None:
        self._inner = inner
        self._recorder = recorder
        self._on_delegate = on_delegate

    async def accept_user_transcript(self, text: str) -> Any:
        return await self._inner.accept_user_transcript(text)

    async def accept_tool_call(self, event: Any) -> Any:
        work_order = event.arguments.get("work_order")
        self._recorder.record(
            "tool.call",
            {
                "call_id": event.call_id,
                "name": event.name,
                "work_order": work_order if isinstance(work_order, str) else "",
            },
        )
        acceptance = await self._inner.accept_tool_call(event)
        if event.name == CODEX_RUN_TOOL_NAME and acceptance.accepted and acceptance.delegate_id:
            self._on_delegate(acceptance.delegate_id)
        self._recorder.record(
            "tool.accepted",
            {
                "call_id": event.call_id,
                "delegate_id": acceptance.delegate_id or "",
                "state": "accepted" if acceptance.accepted else "refused",
            },
        )
        return acceptance

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


def _install(target: Any, attribute: str, wrapper: Any) -> None:
    if not hasattr(target, attribute):
        raise HarnessInvalid(f"observation_seam_moved:{type(target).__name__}.{attribute}")
    setattr(target, attribute, wrapper)


# ---------------------------------------------------------------------------
# The live driver
# ---------------------------------------------------------------------------


class LiveRun:
    def __init__(self, *, workspace: Path, audio: Path, timeout: float) -> None:
        self.workspace = workspace
        self.audio = audio
        self.timeout = timeout
        self.recorder = ScenarioRecorder()
        self.telemetry = HostFactTelemetry()
        self.renderer = SoftwareRenderer()
        self.assembly: Any = None
        self.delegate_id: str | None = None
        self.early_stop: str | None = None
        self._seen_running = False
        self._memory_seen = 0
        self._deadline = 0.0

    # -- observation --------------------------------------------------------

    def _on_delivery(self, completion: Any) -> None:
        text = _artifact_transcript(completion.text or "")
        self.recorder.record(
            "status.transcript",
            {"response_id": completion.response_id, "text": text},
        )
        spoken = self.renderer.bytes_for(completion.utterance_id, completion.generation_epoch)
        if spoken:
            self.recorder.record(
                "audio.delta", {"response_id": completion.response_id, "bytes": spoken}
            )
        event_id = self.telemetry.response_event_ids.get(completion.response_id, "")
        if event_id.startswith(("progress:", "suggestion:")):
            self.recorder.record(
                "progress.response.terminal",
                {"response_id": completion.response_id, "status": completion.disposition},
            )
        elif event_id.startswith("final:"):
            self.recorder.record(
                "final.response.terminal",
                {"response_id": completion.response_id, "status": completion.disposition},
            )

    def _on_codex_state(self, state: str) -> None:
        if state == "running" and not self._seen_running and self.delegate_id:
            self._seen_running = True
            self.recorder.record("delegate.running", {"delegate_id": self.delegate_id})

    def _observe(self, event: Any) -> None:
        if isinstance(event, ProgressEvent) and event.channel == "codex":
            data: dict[str, Any] = {
                "delegate_id": event.delegate_id,
                "phase": event.phase,
                "internal_activity": event.internal_activity,
            }
            if event.summary is not None:
                data["summary"] = event.summary
            self.recorder.record("codex.progress", data)
            self._record_memory_progress()
        elif isinstance(event, HandoffEvent) and event.channel == "codex":
            self.recorder.record(
                "codex.handoff",
                {"delegate_id": event.delegate_id, "outcome": event.outcome},
            )

    def _record_memory_progress(self) -> None:
        channel = self.assembly.runtime.memory.channels.get("codex")
        if channel is None:
            return
        items = [item for item in channel.items if "phase" in item.content]
        for item in items[self._memory_seen :]:
            data: dict[str, Any] = {
                "phase": item.content["phase"],
                "internal_activity": item.content["internal_activity"],
            }
            if "summary" in item.content:
                data["summary"] = item.content["summary"]
            self.recorder.record("memory.progress", data)
        self._memory_seen = len(items)

    # -- wiring -------------------------------------------------------------

    def build(self, settings: Settings) -> None:
        sink_holder: dict[str, Any] = {}

        class _LateSink:
            def emit(self, utterance_id: str, text: str) -> None:
                sink_holder["sink"].emit(utterance_id, text)

            def end(self, utterance_id: str) -> None:
                sink_holder["sink"].end(utterance_id)

        self.assembly = build_qwen_realtime_assembly(
            settings,
            sink=_LateSink(),
            on_audio_frame=self.renderer.on_frame,
            on_audio_clear=self.renderer.on_clear,
            on_audio_terminal=self.renderer.on_terminal,
            on_delivery=self._on_delivery,
            on_codex_state=self._on_codex_state,
            realtime_telemetry=self.telemetry,
        )
        sink_holder["sink"] = RecordingSink(self.assembly.runtime.clock)
        self.renderer.service = self.assembly.service
        provider = RecordingProvider(self.assembly.provider, self.recorder)
        _install(self.assembly.service, "_provider", provider)
        _install(self.assembly.service.session, "_provider", provider)
        _install(
            self.assembly.service,
            "_bridge",
            RecordingBridge(  # noqa: SLF001
                self.assembly.service._bridge,
                self.recorder,
                on_delegate=self._set_delegate_id,
            ),
        )
        self.assembly.runtime.observe(self._observe)

    def _set_delegate_id(self, delegate_id: str) -> None:
        self.delegate_id = delegate_id

    # -- driving ------------------------------------------------------------

    def _remaining(self) -> float:
        remaining = self._deadline - self.recorder.now()
        if remaining <= 0:
            raise HarnessInvalid("scenario_timeout")
        return remaining

    async def _speak(
        self,
        pcm: bytes,
        *,
        trailing_silence_chunks: int = TRAILING_SILENCE_CHUNKS,
    ) -> None:
        chunks = [pcm[offset : offset + CHUNK_BYTES] for offset in range(0, len(pcm), CHUNK_BYTES)]
        chunks.extend([b"\x00" * CHUNK_BYTES] * trailing_silence_chunks)
        for chunk in chunks:
            await self.assembly.service.send_audio(chunk)
            await asyncio.sleep(CHUNK_SECONDS)

    async def _wait_for_record(
        self,
        kind: str,
        predicate: Any = None,
        *,
        after_event_ref: str | None = None,
    ) -> Mapping[str, Any]:
        """Wait for scenario evidence, but fail fast when the realtime session dies."""
        record = asyncio.create_task(
            self.recorder.wait_for(
                kind,
                predicate,
                timeout=self._remaining(),
                after_event_ref=after_event_ref,
            )
        )
        stopped = asyncio.create_task(self.assembly.service.wait_stopped())
        done, pending = await asyncio.wait({record, stopped}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        if record in done:
            return record.result()
        raise HarnessInvalid("realtime_session_stopped")

    def _pre_handoff_summaries(self) -> list[str]:
        summaries: list[str] = []
        for record in self.recorder.records:
            if (
                record["kind"] == "codex.handoff"
                and record["data"].get("delegate_id") == self.delegate_id
            ):
                break
            if (
                record["kind"] == "codex.progress"
                and record["data"].get("delegate_id") == self.delegate_id
                and "summary" in record["data"]
            ):
                summaries.append(str(record["data"]["summary"]))
        return summaries

    async def _await_informative_window(self) -> Mapping[str, Any]:
        """Race the first informative progress fact against a premature Handoff."""
        fact = asyncio.create_task(
            self._wait_for_record(
                "progress.fact",
                lambda record: is_informative(str(record["data"].get("content", ""))),
            )
        )
        handoff = asyncio.create_task(
            self._wait_for_record(
                "codex.handoff",
                lambda record: record["data"].get("delegate_id") == self.delegate_id,
            )
        )
        try:
            done, pending = await asyncio.wait({fact, handoff}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in (fact, handoff):
                if not task.done():
                    task.cancel()
            await asyncio.gather(fact, handoff, return_exceptions=True)
        del pending
        if fact in done and not fact.cancelled():
            # Re-raises ScenarioTimeout, which the caller turns into harness_invalid.
            return fact.result()
        if handoff in done and not handoff.cancelled():
            handoff.result()
            # A real Handoff won the race. The window was valid only if the worker
            # actually produced summaries; otherwise nothing could ever have triggered
            # the question and the attempt proves nothing about progress.
            summaries = self._pre_handoff_summaries()
            if any(is_informative(summary) for summary in summaries):
                self.early_stop = "gate_violation"
                return {}
            if summaries:
                self.early_stop = "no_worker_narration"
                return {}
            raise HarnessInvalid("fixture_too_fast")
        raise HarnessInvalid("progress_observation_window_missing")

    async def run(self) -> None:
        self._deadline = self.recorder.now() + self.timeout
        work_order_pcm = synthesize_pcm(WORK_ORDER, self.audio / "work_order.pcm")
        status_pcm = synthesize_pcm(STATUS_QUESTION, self.audio / "status_question.pcm")

        await self.assembly.start()
        try:
            # 1-3. the fixed work order, one accepted codex__run, a spoken acknowledgement.
            self.recorder.record("user.turn", {"text": WORK_ORDER})
            await self._speak(work_order_pcm)
            accepted = await self._wait_for_record(
                "tool.accepted",
                lambda record: record["data"].get("state") == "accepted",
            )
            self.delegate_id = str(accepted["data"].get("delegate_id") or "")

            # 4-5. wait for an informative selected summary's host fact, then for its
            # response to reach a terminal delivery. Never a fixed sleep.
            fact = await self._await_informative_window()
            if self.early_stop is not None:
                return
            await self._wait_for_record(
                "progress.response.terminal",
                after_event_ref=str(fact["event_ref"]),
            )

            # 6. the delegate must still be running and no Handoff visible.
            if any(
                record["kind"] == "codex.handoff"
                and record["data"].get("delegate_id") == self.delegate_id
                for record in self.recorder.records
            ):
                raise HarnessInvalid("fixture_too_fast")

            # 7. ask during execution and let the answer complete.
            question = self.recorder.record("status.question", {"text": STATUS_QUESTION})
            await self._speak(
                status_pcm,
                trailing_silence_chunks=STATUS_TRAILING_SILENCE_CHUNKS,
            )
            await self._wait_for_record(
                "status.transcript",
                lambda record: bool(str(record["data"].get("text", "")).strip()),
                after_event_ref=str(question["event_ref"]),
            )

            # 8. the terminal Handoff and its prepared final view, delivered once.
            await self._wait_for_record(
                "codex.handoff",
                lambda record: record["data"].get("delegate_id") == self.delegate_id,
            )
            await self._wait_for_record("final.response.terminal")
        except ScenarioTimeout as failure:
            raise HarnessInvalid(failure.code) from None
        finally:
            await self.assembly.stop()


# ---------------------------------------------------------------------------
# Attempts and artifacts
# ---------------------------------------------------------------------------


def _preflight(settings: Settings) -> dict[str, Any]:
    for tool in ("say", "ffmpeg"):
        if shutil.which(tool) is None:
            raise HarnessInvalid(f"missing_tool:{tool}")
    try:
        # (url, model, voice, api_key) — the credential is unpacked only to discard it.
        url, model, voice, _api_key = settings.require_qwen_realtime()
    except ConfigurationError as failure:
        raise HarnessInvalid(f"missing_realtime_credential:{failure}") from None
    try:
        _workspace, binary, _codex_key = settings.require_codex()
    except ConfigurationError as failure:
        raise HarnessInvalid(f"missing_codex_configuration:{failure}") from None
    return {
        "realtime_endpoint_host": urlsplit(url).hostname or "unknown",
        "realtime_model": model,
        "realtime_voice": voice,
        "codex_binary": Path(binary).name,
        "codex_binary_version": _binary_version(binary),
    }


def _binary_version(binary: str) -> str | None:
    try:
        completed = subprocess.run(
            [binary, "--version"], capture_output=True, text=True, timeout=30, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return completed.stdout.strip()[:80] or None


def _fixture_digest(hashes: Mapping[str, str]) -> str:
    payload = json.dumps(dict(sorted(hashes.items())), separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _write_artifacts(
    directory: Path,
    *,
    manifest: Mapping[str, Any],
    records: tuple[Mapping[str, Any], ...],
    report: Mapping[str, Any],
) -> None:
    directory.mkdir(parents=True, exist_ok=False)
    (directory / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    with (directory / "events.ndjson").open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(dict(record), ensure_ascii=False, sort_keys=True) + "\n")
    (directory / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _write_harness_invalid_artifacts(
    directory: Path,
    *,
    manifest: Mapping[str, Any],
    records: tuple[Mapping[str, Any], ...],
    reason: str,
) -> None:
    """Persist the bounded evidence collected before an invalid attempt stopped."""
    report = {
        "scenario_id": SCENARIO_ID,
        "manifest": dict(manifest),
        "status": "harness_invalid",
        "passed": False,
        "failure_reason": reason,
        "first_failed_gate": None,
        "gates": [],
        "findings": [],
        "metrics": {},
        "event_count": len(records),
        "event_refs": [record.get("event_ref") for record in records],
    }
    _write_artifacts(directory, manifest=manifest, records=records, report=report)


async def _attempt(args: argparse.Namespace, attempt: int) -> int:
    directory = args.output / f"attempt-{attempt}"
    if directory.exists():
        raise HarnessInvalid(f"artifact_directory_exists:{directory.name}")

    with (
        create_contracted_workspace() as workspace,
        tempfile.TemporaryDirectory(prefix="nova-progress-status-audio-") as scratch,
    ):
        # The fixture copy IS this run's Codex workspace, so preflight has to happen
        # after it exists: `require_codex()` rejects a settings object whose
        # NOVA_AUDIO_AGENT_CODEX_WORKSPACE is unset or not a directory, and operators are not
        # expected to configure one for a scenario that brings its own fixture.
        settings = Settings(executor="codex", codex_workspace=workspace)
        environment = _preflight(settings)
        audio = Path(scratch) / "audio"
        audio.mkdir()
        before = workspace_hashes(workspace)
        manifest = {
            "scenario_id": SCENARIO_ID,
            "scenario_version": SCENARIO_VERSION,
            "attempt": attempt,
            "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "fixture": "contracted_tetris",
            "fixture_digest": _fixture_digest(before),
            "fixture_file_count": len(before),
            "timeout_s": args.timeout,
            **environment,
        }

        run = LiveRun(workspace=workspace, audio=audio, timeout=args.timeout)
        try:
            run.build(settings)
            await run.run()
        except HarnessInvalid as failure:
            _write_harness_invalid_artifacts(
                directory,
                manifest=manifest,
                records=run.recorder.records,
                reason=failure.reason,
            )
            raise
        except Exception as failure:  # noqa: BLE001 - any startup fault is harness_invalid
            invalid = HarnessInvalid(f"live_run_failed:{type(failure).__name__}")
            _write_harness_invalid_artifacts(
                directory,
                manifest=manifest,
                records=run.recorder.records,
                reason=invalid.reason,
            )
            raise invalid from None

        # Gate 6: the harness verifies the workspace itself instead of trusting Codex.
        artifact = await asyncio.to_thread(check_tetris_artifact, workspace)
        for gate in artifact.gates:
            run.recorder.record("fixture.gate", {"name": gate.name, "passed": gate.passed})
        after = workspace_hashes(workspace)
        fixture_detail = {
            "contract": "TASK_CONTRACT.md",
            "changed_paths": list(changed_paths(before, after)),
            "gates": [
                {"name": gate.name, "passed": gate.passed, "findings": list(gate.findings)}
                for gate in artifact.gates
            ],
        }
        records = run.recorder.records
        report = evaluate_codex_progress_status(
            records,
            live=True,
            required_fixture_gates=REQUIRED_TETRIS_GATES,
        )
        classification = run.early_stop or failure_reason(report)
        passed = report.passed and classification is None

        mapping = build_report_mapping(report, records=records, manifest=manifest)
        mapping["passed"] = passed
        mapping["failure_reason"] = classification
        mapping["fixture_verification"] = fixture_detail
        _write_artifacts(directory, manifest=manifest, records=records, report=mapping)

    print(
        f"[{SCENARIO_ID}] attempt={attempt} passed={passed} "
        f"reason={classification} first_failed_gate={report.first_failed_gate} "
        f"artifacts={directory}",
        flush=True,
    )
    return EXIT_PASS if passed else EXIT_FAIL


async def _main(args: argparse.Namespace) -> int:
    args.output.mkdir(parents=True, exist_ok=True)
    last: str = "unknown"
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            # A semantic verdict is returned as-is: only harness_invalid ever retries.
            return await _attempt(args, attempt)
        except HarnessInvalid as failure:
            last = failure.reason
            print(
                f"[{SCENARIO_ID}] attempt={attempt} harness_invalid reason={failure.reason}",
                flush=True,
            )
    (args.output / "harness_invalid.json").write_text(
        json.dumps(
            {
                "scenario_id": SCENARIO_ID,
                "status": "harness_invalid",
                "reason": last,
                "attempts": MAX_ATTEMPTS,
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return EXIT_HARNESS_INVALID


def main() -> int:
    parser = argparse.ArgumentParser(description=f"Run the live {SCENARIO_ID} scenario.")
    parser.add_argument("--output", type=Path, required=True, help="artifact directory")
    parser.add_argument("--timeout", type=float, default=600.0)
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    return asyncio.run(_main(args))


if __name__ == "__main__":
    raise SystemExit(main())
