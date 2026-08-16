from __future__ import annotations

import asyncio
import base64
from collections import defaultdict
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from .evaluate import evaluate_interruption
from .models import GateResult, ProbeEvent, ProbeReport, ScenarioStep
from .playback import RealtimePcmSink
from .provider import ProviderError
from .qwen import QWEN_MODEL, QwenProtocol
from .runner import RealtimeProbeSession, ResponseCapture
from .scenario import build_scenario


@dataclass(slots=True)
class InterruptionOutcome:
    report: ProbeReport
    events: list[ProbeEvent]
    raw_provider_events: list[dict[str, object]]
    audio: dict[str, bytes]


@dataclass(slots=True)
class SmartCancelTurnResult:
    progress: ResponseCapture
    foreground: ResponseCapture
    rendered_progress_audio: bytes
    foreground_audio: bytes
    metrics: dict[str, int | str]


SinkFactory = Callable[[], RealtimePcmSink]


def _first_provider_error(error: BaseException) -> ProviderError | None:
    if isinstance(error, ProviderError):
        return error
    if isinstance(error, BaseExceptionGroup):
        for nested in error.exceptions:
            if provider_error := _first_provider_error(nested):
                return provider_error
    return None


async def collect_smart_cancel_turn(
    session: RealtimeProbeSession,
    *,
    progress_step: ScenarioStep,
    barge_pcm: bytes,
    nonce: str,
    sink_factory: SinkFactory = RealtimePcmSink,
) -> SmartCancelTurnResult:
    sink = sink_factory()
    sink_cleanup_task: asyncio.Task[None] | None = None
    progress_response_id = ""
    foreground_response_id = ""
    foreground_audio: list[bytes] = []
    response_purpose: dict[str, str] = {}
    response_item_ids: dict[str, list[str]] = defaultdict(list)
    transcript_parts: dict[str, list[str]] = defaultdict(list)
    transcript_done: dict[str, str] = {}
    transcript_complete: set[str] = set()
    recorded_transcripts: set[str] = set()
    terminal_status: dict[str, str] = {}
    terminal_details: dict[str, object] = {}
    terminal_usage: dict[str, dict[str, object]] = {}
    terminal_recorded: set[str] = set()
    prior_response_ids = {
        response_id
        for event in session.events
        if (response_id := event.provider.get("response_id"))
    }
    progress_lifecycle_started = False
    barge_input_started = asyncio.Event()
    cancel_recorded = asyncio.Event()
    receiver_complete = asyncio.Event()
    barge_complete = asyncio.Event()
    user_transcript = ""

    async def finish_sink() -> None:
        nonlocal sink_cleanup_task
        if sink_cleanup_task is None:
            sink_cleanup_task = asyncio.create_task(sink.finish())
        await asyncio.shield(sink_cleanup_task)

    def purpose_for(response_id: str) -> str | None:
        nonlocal foreground_response_id, progress_response_id
        if response_id in response_purpose:
            return response_purpose[response_id]
        if response_id in prior_response_ids:
            return None
        if progress_lifecycle_started and not progress_response_id:
            progress_response_id = response_id
            response_purpose[response_id] = "progress"
        elif barge_input_started.is_set() and not foreground_response_id:
            foreground_response_id = response_id
            response_purpose[response_id] = "foreground"
        return response_purpose.get(response_id)

    def accumulate_item_ids(event: Mapping[str, object], response_id: str) -> None:
        item_ids: list[str] = []
        item_id = event.get("item_id")
        if item_id:
            item_ids.append(str(item_id))
        item = event.get("item")
        if isinstance(item, dict) and item.get("id"):
            item_ids.append(str(item["id"]))
        response = event.get("response")
        if isinstance(response, dict):
            output = response.get("output")
            if isinstance(output, list):
                item_ids.extend(
                    str(item["id"]) for item in output if isinstance(item, dict) and item.get("id")
                )
        known = response_item_ids[response_id]
        known.extend(item_id for item_id in item_ids if item_id not in known)

    def provider_identity(response_id: str) -> tuple[dict[str, str], list[str]]:
        item_ids = response_item_ids[response_id]
        provider = {"response_id": response_id}
        if item_ids:
            provider["item_id"] = item_ids[0]
        return provider, list(item_ids)

    def record_transcript(response_id: str, purpose: str, *, allow_partial: bool = False) -> None:
        if response_id in recorded_transcripts:
            return
        if response_id not in transcript_complete and not allow_partial:
            return
        text = transcript_done.get(response_id)
        if not text and allow_partial:
            text = "".join(transcript_parts[response_id])
        if not text:
            return
        provider, _ = provider_identity(response_id)
        session.record_event(
            "assistant.transcript",
            actor="provider",
            provider=provider,
            purpose=purpose,
            text=text,
            **({"cause_event_id": progress_step.step_id} if purpose == "progress" else {}),
        )
        recorded_transcripts.add(response_id)

    def response_output_transcript(response: Mapping[str, object]) -> str:
        output = response.get("output")
        if not isinstance(output, list):
            return ""
        parts: list[str] = []
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if not isinstance(content, list):
                continue
            for part in content:
                if not isinstance(part, dict):
                    continue
                value = part.get("transcript", part.get("text", ""))
                if isinstance(value, str):
                    parts.append(value)
        return "".join(parts)

    async def record_terminal(response_id: str, purpose: str) -> None:
        if response_id in terminal_recorded:
            return
        if purpose == "progress":
            await cancel_recorded.wait()
        provider, output_item_ids = provider_identity(response_id)
        status = terminal_status[response_id]
        kind = "provider.response_cancelled" if status == "cancelled" else "provider.response_done"
        session.record_event(
            kind,
            actor="provider",
            provider=provider,
            purpose=purpose,
            status=status,
            status_details=terminal_details[response_id],
            output_item_ids=output_item_ids,
            **({"cause_event_id": progress_step.step_id} if purpose == "progress" else {}),
        )
        terminal_recorded.add(response_id)
        record_transcript(
            response_id,
            purpose,
            allow_partial=purpose == "progress" and status == "cancelled",
        )

    def complete() -> bool:
        return bool(
            progress_response_id
            and progress_response_id in terminal_recorded
            and user_transcript
            and foreground_response_id
            and terminal_status.get(foreground_response_id) == "completed"
            and foreground_response_id in terminal_recorded
            and foreground_response_id in transcript_complete
            and foreground_response_id in recorded_transcripts
        )

    async def receiver() -> None:
        nonlocal user_transcript
        while not complete():
            event = await session.receive_provider_event()
            event_type = str(event.get("type", ""))
            if event_type == "input_audio_buffer.speech_started":
                item_id = str(event.get("item_id", ""))
                session.record_event(
                    "provider.user_speech_started",
                    actor="user",
                    provider={"item_id": item_id} if item_id else {},
                    purpose="barge_in",
                )
                continue
            if event_type == "conversation.item.input_audio_transcription.completed":
                if not barge_input_started.is_set():
                    continue
                user_transcript = str(event.get("transcript", ""))
                item_id = str(event.get("item_id", ""))
                session.record_event(
                    "provider.user_transcript",
                    actor="user",
                    provider={"item_id": item_id} if item_id else {},
                    purpose="barge_in",
                    text=user_transcript,
                )
                continue

            response = event.get("response")
            response_id = str(event.get("response_id", ""))
            if not response_id and isinstance(response, dict):
                response_id = str(response.get("id", ""))
            if not response_id:
                continue
            purpose = purpose_for(response_id)
            if purpose is None:
                continue
            accumulate_item_ids(event, response_id)
            provider, _ = provider_identity(response_id)

            if event_type == "response.audio.delta":
                encoded = event.get("delta")
                if not isinstance(encoded, str):
                    raise ProviderError("Qwen realtime returned invalid audio delta")
                try:
                    pcm = base64.b64decode(encoded, validate=True)
                except ValueError as exc:
                    raise ProviderError("Qwen realtime returned invalid base64 audio") from exc
                session.record_event(
                    "provider.audio_delta",
                    actor="provider",
                    provider=provider,
                    purpose=purpose,
                    **({"cause_event_id": progress_step.step_id} if purpose == "progress" else {}),
                )
                if purpose == "progress":
                    await sink.enqueue(response_id, pcm)
                else:
                    foreground_audio.append(pcm)
            elif event_type in {"response.audio_transcript.delta", "response.text.delta"}:
                delta = event.get("delta")
                if isinstance(delta, str):
                    transcript_parts[response_id].append(delta)
            elif event_type in {
                "response.audio_transcript.done",
                "response.text.done",
                "response.output_text.done",
            }:
                value = event.get("transcript", event.get("text", ""))
                if isinstance(value, str):
                    transcript_done[response_id] = value
                    transcript_complete.add(response_id)
                    if response_id in terminal_recorded:
                        record_transcript(response_id, purpose)
            elif event_type == "response.done" and isinstance(response, dict):
                status = str(response.get("status", "completed"))
                terminal_status[response_id] = status
                terminal_details[response_id] = response.get("status_details")
                usage = response.get("usage")
                if isinstance(usage, dict):
                    terminal_usage[response_id] = dict(usage)
                fallback = response_output_transcript(response)
                if fallback:
                    transcript_done[response_id] = fallback
                    transcript_complete.add(response_id)
                await record_terminal(response_id, purpose)
        receiver_complete.set()

    async def barge_worker() -> None:
        await sink.first_rendered.wait()
        session.record_event(
            "local.playback_rendered",
            actor="host",
            provider={"response_id": progress_response_id},
            purpose="progress",
            cause_event_id=progress_step.step_id,
        )
        session.record_event(
            "local.speech_onset",
            actor="user",
            provider={"response_id": progress_response_id},
            purpose="barge_in",
            cause_event_id=progress_step.step_id,
        )
        stop = await sink.stop_response(progress_response_id)
        session.record_event(
            "local.playback_stopped",
            provider={"response_id": progress_response_id},
            purpose="progress",
            cause_event_id=progress_step.step_id,
            cleared_bytes=stop.cleared_bytes,
            rendered_after_fence_bytes=sink.metrics.rendered_after_fence_bytes,
        )
        await session.provider.send(QwenProtocol.response_cancel())
        session.record_event(
            "host.response_cancel",
            provider={"response_id": progress_response_id},
            purpose="progress",
            cause_event_id=progress_step.step_id,
        )
        cancel_recorded.set()
        barge_input_started.set()
        await session.stream_interruption_audio(barge_pcm)
        barge_complete.set()

    cancellation_in_flight = False
    try:
        await session.start_progress(progress_step, nonce=nonce)
        progress_lifecycle_started = True

        async with asyncio.timeout(session.timeout_s * 2):
            async with asyncio.TaskGroup() as tasks:
                tasks.create_task(sink.run(), name="smart-cancel-sink")
                tasks.create_task(receiver(), name="smart-cancel-receiver")
                tasks.create_task(barge_worker(), name="smart-cancel-barge")
                await receiver_complete.wait()
                await barge_complete.wait()
                await finish_sink()

        rendered_progress_audio = sink.rendered_pcm(progress_response_id)
        session.state.mark_interrupted(progress_step.step_id)
        session.record_event(
            "host.progress_interrupted",
            provider={"response_id": progress_response_id},
            progress_id=progress_step.step_id,
            rendered_bytes=len(rendered_progress_audio),
        )
        session.record_event(
            "host.delegate_status",
            delegate_status=session.state.delegate_status,
        )

        def first_event(kind: str, *, purpose: str) -> ProbeEvent | None:
            return next(
                (
                    event
                    for event in session.events
                    if event.kind == kind and event.data.get("purpose") == purpose
                ),
                None,
            )

        def elapsed_ms(start: ProbeEvent | None, end: ProbeEvent | None) -> int | str:
            if start is None or end is None:
                return "unknown"
            return end.t_ms - start.t_ms

        onset = first_event("local.speech_onset", purpose="barge_in")
        playback_stop = first_event("local.playback_stopped", purpose="progress")
        cancel_sent = first_event("host.response_cancel", purpose="progress")
        provider_cancelled = first_event("provider.response_cancelled", purpose="progress")
        foreground_audio_event = first_event("provider.audio_delta", purpose="foreground")
        progress_text = transcript_done.get(progress_response_id) or "".join(
            transcript_parts[progress_response_id]
        )
        foreground_text = transcript_done.get(foreground_response_id) or "".join(
            transcript_parts[foreground_response_id]
        )
        foreground_pcm = b"".join(foreground_audio)
        return SmartCancelTurnResult(
            progress=ResponseCapture(
                response_id=progress_response_id,
                status=terminal_status[progress_response_id],
                transcript=progress_text,
                audio=rendered_progress_audio,
                usage=terminal_usage.get(progress_response_id),
            ),
            foreground=ResponseCapture(
                response_id=foreground_response_id,
                status=terminal_status[foreground_response_id],
                transcript=foreground_text,
                audio=foreground_pcm,
                usage=terminal_usage.get(foreground_response_id),
            ),
            rendered_progress_audio=rendered_progress_audio,
            foreground_audio=foreground_pcm,
            metrics={
                "onset_to_playback_stop_ms": elapsed_ms(onset, playback_stop),
                "onset_to_cancel_sent_ms": elapsed_ms(onset, cancel_sent),
                "cancel_to_provider_cancelled_ms": elapsed_ms(cancel_sent, provider_cancelled),
                "onset_to_first_foreground_audio_ms": elapsed_ms(onset, foreground_audio_event),
                "cleared_bytes": sink.metrics.cleared_bytes,
                "late_discarded_bytes": sink.metrics.late_discarded_bytes,
                "rendered_after_fence_bytes": sink.metrics.rendered_after_fence_bytes,
            },
        )
    except asyncio.CancelledError:
        cancellation_in_flight = True
        try:
            await finish_sink()
        except (asyncio.CancelledError, Exception):
            pass
        raise
    except ProviderError:
        raise
    except TimeoutError:
        raise ProviderError(
            "Qwen realtime smart-cancel orchestration failed",
            reason_code="smart_cancel_timeout",
        ) from None
    except Exception as exc:
        if provider_error := _first_provider_error(exc):
            raise provider_error from None
        raise ProviderError(
            "Qwen realtime smart-cancel orchestration failed",
            reason_code="smart_cancel_orchestration_failed",
        ) from None
    finally:
        if sink_cleanup_task is None:
            try:
                await finish_sink()
            except Exception:
                if not cancellation_in_flight:
                    raise ProviderError(
                        "Qwen realtime smart-cancel cleanup failed",
                        reason_code="smart_cancel_cleanup_failed",
                    ) from None


async def execute_smart_cancel(
    session: RealtimeProbeSession,
    fixture_pcm: Mapping[str, bytes],
    *,
    sink_factory: SinkFactory = RealtimePcmSink,
) -> InterruptionOutcome:
    try:
        await session.connect(turn_detection={"type": "smart_turn"})
        acknowledgement = await session.request_delegate(
            fixture_pcm["delegate_request"], manual=False
        )
        progress_step = next(
            step for step in build_scenario("full") if step.step_id == "progress-1"
        )
        turn = await collect_smart_cancel_turn(
            session,
            progress_step=progress_step,
            barge_pcm=fixture_pcm["barge_in"],
            nonce="interruption-probe",
            sink_factory=sink_factory,
        )
        gate = evaluate_interruption(session.events)
        merged_usage: dict[str, int | float] = {}
        for capture in (acknowledgement, turn.progress, turn.foreground):
            for key, value in (capture.usage or {}).items():
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    merged_usage[key] = merged_usage.get(key, 0) + value
        report = ProbeReport.for_run(
            provider="qwen",
            model=QWEN_MODEL,
            phase="interruption",
            run_id=session.state.run_id,
            gates=[gate],
            metrics={**turn.metrics, "usage": merged_usage or "unknown"},
        )
        return InterruptionOutcome(
            report=report,
            events=list(session.events),
            raw_provider_events=list(session.raw_provider_events),
            audio={
                "progress_rendered": turn.rendered_progress_audio,
                "foreground": turn.foreground_audio,
            },
        )
    except ProviderError:
        raise
    except Exception:
        raise ProviderError(
            "Qwen realtime smart-cancel orchestration failed",
            reason_code="smart_cancel_orchestration_failed",
        ) from None


async def execute_auto_cancel_baseline(
    session: RealtimeProbeSession,
    fixture_pcm: Mapping[str, bytes],
) -> InterruptionOutcome:
    """Measure a provider-owned Smart Turn response that rejects cancellation."""
    try:
        await session.connect(turn_detection={"type": "smart_turn"})
        target_pcm = fixture_pcm["barge_in"]
        session.record_event(
            "host.auto_cancel_target_sent",
            purpose="target",
            input_bytes=len(target_pcm),
        )
        await session.stream_audio(target_pcm)

        target_response_id = ""
        target_audio: list[bytes] = []
        cancel_sent: ProbeEvent | None = None
        rejection: ProbeEvent | None = None
        guard_hit: ProbeEvent | None = None
        old_terminal: ProbeEvent | None = None

        while old_terminal is None:
            event = await session.receive_provider_event()
            event_type = str(event.get("type", ""))
            if event_type == "conversation.item.input_audio_transcription.completed":
                session.record_event(
                    "provider.user_transcript",
                    actor="user",
                    provider={"item_id": str(event.get("item_id", ""))},
                    purpose="target",
                    text=str(event.get("transcript", "")),
                )
                continue
            if event_type == "probe.response_cancel_rejected":
                if cancel_sent is None or rejection is not None:
                    raise ProviderError("Qwen returned an unexpected cancel rejection")
                rejection = session.record_event(
                    "provider.response_cancel_rejected",
                    actor="provider",
                    provider={"response_id": target_response_id},
                    purpose="target",
                    reason="no_active_response",
                )
                continue
            if event_type == "response.audio.delta":
                response_id = str(event.get("response_id", ""))
                if not target_response_id:
                    target_response_id = response_id
                if response_id != target_response_id:
                    raise ProviderError("Qwen started another response before the target terminal")
                encoded = event.get("delta")
                if not isinstance(encoded, str):
                    raise ProviderError("Qwen realtime returned invalid audio delta")
                try:
                    target_audio.append(base64.b64decode(encoded, validate=True))
                except ValueError as exc:
                    raise ProviderError("Qwen realtime returned invalid base64 audio") from exc
                session.record_event(
                    "provider.audio_delta",
                    actor="provider",
                    provider={"response_id": response_id},
                    purpose="target",
                )
                if cancel_sent is None:
                    guard_hit = session.record_event(
                        "host.guard_hit",
                        provider={"response_id": response_id},
                        purpose="guard",
                    )
                    await session.provider.send(QwenProtocol.response_cancel())
                    cancel_sent = session.record_event(
                        "host.response_cancel",
                        provider={"response_id": response_id},
                        purpose="target",
                    )
                continue
            if event_type == "response.done":
                response = event.get("response")
                if not isinstance(response, dict):
                    raise ProviderError("Qwen realtime returned an invalid response terminal")
                response_id = str(response.get("id", ""))
                if not target_response_id or response_id != target_response_id:
                    raise ProviderError("Qwen returned a mismatched target terminal")
                status = str(response.get("status", "completed"))
                old_terminal = session.record_event(
                    "provider.response_done",
                    actor="provider",
                    provider={"response_id": response_id},
                    purpose="target",
                    status=status,
                )
                if status != "completed" or rejection is None:
                    raise ProviderError(
                        "Qwen automatic cancel baseline trajectory was not observed"
                    )

        guard_item_id = "item_auto_cancel_guard"
        guard_item = {
            "id": guard_item_id,
            "type": "message",
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": (
                        "<nova_guard_event>\n"
                        "provenance=nova-audio-agent_host_guard_fact\n"
                        "event_id=auto-cancel-baseline-guard\n"
                        "fact=检测到水杯正在倾倒，请立即发出简短告警。\n"
                        "</nova_guard_event>"
                    ),
                }
            ],
        }
        await session.provider.send(QwenProtocol.item_create(guard_item))
        while True:
            confirmation = await session.receive_provider_event()
            item = confirmation.get("item")
            if (
                confirmation.get("type") == "conversation.item.created"
                and isinstance(item, dict)
                and item.get("id") == guard_item_id
            ):
                break
        session.record_event(
            "provider.item_created",
            actor="provider",
            provider={"item_id": guard_item_id},
            purpose="guard",
        )
        await session.provider.send(QwenProtocol.response_create())
        guard_create = session.record_event(
            "host.response_create",
            purpose="guard",
            cause_event_id="auto-cancel-baseline-guard",
        )
        guard = await session.collect_response(
            purpose="guard",
            cause_event_id="auto-cancel-baseline-guard",
        )
        first_guard_audio = next(
            (
                event
                for event in session.events
                if event.kind == "provider.audio_delta"
                and event.data.get("purpose") == "guard"
                and event.t_ms > guard_create.t_ms
            ),
            None,
        )
        if first_guard_audio is None or not guard.audio:
            raise ProviderError("Qwen automatic cancel baseline Guard audio is missing")
        assert cancel_sent is not None
        assert rejection is not None
        assert guard_hit is not None
        gate = GateResult(
            0,
            "auto_cancel_baseline",
            "pass",
            [rejection.event_ref, old_terminal.event_ref, first_guard_audio.event_ref],
        )
        report = ProbeReport.for_run(
            provider="qwen",
            model=QWEN_MODEL,
            phase="interruption",
            run_id=session.state.run_id,
            gates=[gate],
            metrics={
                "cancel_to_rejection_ms": rejection.t_ms - cancel_sent.t_ms,
                "cancel_to_old_terminal_ms": old_terminal.t_ms - cancel_sent.t_ms,
                "guard_create_to_first_audio_ms": first_guard_audio.t_ms - guard_create.t_ms,
                "guard_end_to_end_ms": first_guard_audio.t_ms - guard_hit.t_ms,
            },
        )
        return InterruptionOutcome(
            report=report,
            events=list(session.events),
            raw_provider_events=list(session.raw_provider_events),
            audio={
                "target_automatic_response": b"".join(target_audio),
                "guard": guard.audio,
            },
        )
    except ProviderError:
        raise
    except Exception:
        raise ProviderError(
            "Qwen realtime auto-cancel baseline orchestration failed",
            reason_code="auto_cancel_baseline_orchestration_failed",
        ) from None
