from __future__ import annotations

import asyncio
import base64
import re
import time
from dataclasses import dataclass
from typing import Any

from .models import HostState, ProbeEvent, ScenarioStep
from .provider import ProviderError, RealtimeProvider
from .qwen import QwenProtocol


@dataclass(slots=True)
class ResponseCapture:
    response_id: str
    status: str
    transcript: str
    audio: bytes
    usage: dict[str, Any] | None = None


class RealtimeProbeSession:
    def __init__(
        self,
        *,
        provider: RealtimeProvider,
        state: HostState,
        timeout_s: float = 30.0,
        pace_audio: bool = False,
    ) -> None:
        self.provider = provider
        self.state = state
        self.timeout_s = timeout_s
        self._pace_audio = pace_audio
        self.events: list[ProbeEvent] = []
        self.raw_provider_events: list[dict[str, object]] = []
        self.session_id = ""
        self._started_ns = time.monotonic_ns()
        self._event_sequence = 0
        self._last_t_ms = -1
        self._manual_mode = True
        self.last_barge_progress: ResponseCapture | None = None

    def _now_ms(self) -> int:
        return (time.monotonic_ns() - self._started_ns) // 1_000_000

    def _record(
        self,
        kind: str,
        *,
        actor: str = "host",
        provider: dict[str, str] | None = None,
        **data: object,
    ) -> ProbeEvent:
        self._event_sequence += 1
        t_ms = max(self._now_ms(), self._last_t_ms + 1)
        self._last_t_ms = t_ms
        event = ProbeEvent(
            event_ref=f"e{self._event_sequence:04d}",
            t_ms=t_ms,
            kind=kind,
            actor=actor,
            run_id=self.state.run_id,
            delegate_id=self.state.delegate_id,
            provider=provider or {},
            data=data,
        )
        self.events.append(event)
        return event

    async def _receive(self) -> dict[str, object]:
        try:
            async with asyncio.timeout(self.timeout_s):
                event = await self.provider.receive()
        except TimeoutError as exc:
            raise ProviderError(
                "Qwen realtime event timeout",
                reason_code="qwen_event_timeout",
            ) from exc
        self.raw_provider_events.append(event)
        return event

    async def receive_provider_event(self) -> dict[str, object]:
        return await self._receive()

    def record_event(self, kind: str, **data: object) -> ProbeEvent:
        return self._record(kind, **data)

    async def _wait_for(
        self,
        event_type: str,
        *,
        item_id: str | None = None,
    ) -> dict[str, object]:
        while True:
            event = await self._receive()
            if event.get("type") != event_type:
                continue
            if item_id is not None:
                item = event.get("item")
                if not isinstance(item, dict) or item.get("id") != item_id:
                    continue
            return event

    async def connect(self, *, turn_detection: dict[str, object] | None) -> None:
        self._manual_mode = turn_detection is None
        created = await self.provider.connect()
        session = created.get("session")
        if isinstance(session, dict):
            self.session_id = str(session.get("id", ""))
        self.raw_provider_events.append(created)
        self._record(
            "provider.session_created",
            actor="provider",
            provider={"session_id": self.session_id},
        )
        await self.provider.send(QwenProtocol.session_update(turn_detection=turn_detection))
        updated = await self._wait_for("session.updated")
        updated_session = updated.get("session")
        if isinstance(updated_session, dict) and updated_session.get("id"):
            self.session_id = str(updated_session["id"])
        self._record(
            "provider.session_updated",
            actor="provider",
            provider={"session_id": self.session_id},
        )

    @staticmethod
    def _safe_id(value: str) -> str:
        return re.sub(r"[^a-zA-Z0-9_-]", "_", value)[:60]

    async def _create_item_and_confirm(
        self,
        item: dict[str, object],
        *,
        progress_id: str | None = None,
    ) -> dict[str, object]:
        item_id = str(item["id"])
        await self.provider.send(QwenProtocol.item_create(item))
        confirmation = await self._wait_for("conversation.item.created", item_id=item_id)
        self._record(
            "provider.item_created",
            actor="provider",
            provider={"item_id": item_id},
            **({"progress_id": progress_id} if progress_id else {}),
        )
        return confirmation

    async def collect_response(
        self,
        *,
        purpose: str,
        cause_event_id: str | None = None,
    ) -> ResponseCapture:
        transcript_parts: list[str] = []
        transcript_done = ""
        audio_parts: list[bytes] = []
        response_id = ""
        status = "unknown"
        usage: dict[str, Any] | None = None
        while True:
            event = await self._receive()
            event_type = str(event.get("type"))
            if event_type == "conversation.item.input_audio_transcription.completed":
                self._record(
                    "provider.user_transcript",
                    actor="user",
                    provider={"item_id": str(event.get("item_id", ""))},
                    purpose=purpose,
                    text=str(event.get("transcript", "")),
                )
            elif event_type == "response.audio.delta":
                response_id = str(event.get("response_id", response_id))
                delta = event.get("delta")
                if isinstance(delta, str):
                    try:
                        audio_parts.append(base64.b64decode(delta, validate=True))
                    except ValueError as exc:
                        raise ProviderError("Qwen realtime returned invalid base64 audio") from exc
                self._record(
                    "provider.audio_delta",
                    actor="provider",
                    provider={"response_id": response_id},
                    purpose=purpose,
                    **({"cause_event_id": cause_event_id} if cause_event_id else {}),
                )
            elif event_type in {"response.audio_transcript.delta", "response.text.delta"}:
                delta = event.get("delta")
                if isinstance(delta, str):
                    transcript_parts.append(delta)
            elif event_type in {
                "response.audio_transcript.done",
                "response.text.done",
                "response.output_text.done",
            }:
                response_id = str(event.get("response_id", response_id))
                value = event.get("transcript", event.get("text", ""))
                if isinstance(value, str):
                    transcript_done = value
            elif event_type == "response.done":
                response = event.get("response")
                if isinstance(response, dict):
                    response_id = str(response.get("id", response_id))
                    status = str(response.get("status", "completed"))
                    if isinstance(response.get("usage"), dict):
                        usage = dict(response["usage"])
                kind = (
                    "provider.response_cancelled"
                    if status == "cancelled"
                    else "provider.response_done"
                )
                self._record(
                    kind,
                    actor="provider",
                    provider={"response_id": response_id},
                    purpose=purpose,
                    **({"cause_event_id": cause_event_id} if cause_event_id else {}),
                )
                break
        transcript = transcript_done or "".join(transcript_parts)
        if transcript:
            self._record(
                "assistant.transcript",
                actor="provider",
                provider={"response_id": response_id},
                purpose=purpose,
                text=transcript,
                **({"cause_event_id": cause_event_id} if cause_event_id else {}),
            )
        return ResponseCapture(
            response_id=response_id,
            status=status,
            transcript=transcript,
            audio=b"".join(audio_parts),
            usage=usage,
        )

    async def start_progress(self, step: ScenarioStep, *, nonce: str) -> None:
        progress_id = step.step_id
        if progress_id in self.state.injected_progress_ids:
            raise ProviderError(f"progress already injected: {progress_id}")
        item_id = f"item_{self._safe_id(self.state.run_id)}_{self._safe_id(progress_id)}"
        self.state.mark_injected(progress_id)
        item = QwenProtocol.progress_item(
            item_id=item_id,
            run_id=self.state.run_id,
            delegate_id=self.state.delegate_id,
            progress_id=progress_id,
            nonce=nonce,
            fact=step.text,
        )
        self._record(
            "host.progress_injected",
            provider={"item_id": item_id},
            progress_id=progress_id,
            nonce=nonce,
            fact=step.text,
            required_terms=list(step.data.get("required_terms", [])),
            snapshot_version=self.state.snapshot_version,
        )
        await self._create_item_and_confirm(item, progress_id=progress_id)
        self._record("host.response_create", progress_id=progress_id)
        await self.provider.send(QwenProtocol.response_create())

    async def inject_progress(self, step: ScenarioStep, *, nonce: str) -> ResponseCapture:
        await self.start_progress(step, nonce=nonce)
        progress_id = step.step_id
        response = await self.collect_response(purpose="progress", cause_event_id=progress_id)
        if response.status == "completed":
            self.state.mark_spoken(progress_id)
            self._record("host.progress_spoken", progress_id=progress_id)
        return response

    async def inject_recovery_snapshot(self) -> None:
        item_id = f"item_{self._safe_id(self.state.run_id)}_recovery_{self.state.snapshot_version}"
        item = QwenProtocol.recovery_item(item_id=item_id, state=self.state)
        await self._create_item_and_confirm(item)
        self._record(
            "host.recovery_snapshot",
            provider={"item_id": item_id},
            snapshot_version=self.state.snapshot_version,
            delegate_status=self.state.delegate_status,
            delivered_progress_ids=list(self.state.spoken_progress_ids),
            interrupted_progress_ids=list(self.state.interrupted_progress_ids),
        )

    async def stream_audio(self, pcm: bytes) -> None:
        if not pcm or len(pcm) % 2:
            raise ValueError("PCM audio must be non-empty 16-bit samples")
        chunks = [pcm[offset : offset + 3200] for offset in range(0, len(pcm), 3200)]
        if not self._manual_mode:
            chunks.extend([b"\x00" * 3200] * 10)
        for chunk in chunks:
            await self.provider.send(QwenProtocol.audio_append(chunk))
            if self._pace_audio and not self._manual_mode:
                await asyncio.sleep(len(chunk) / 32_000)

    async def stream_interruption_audio(self, pcm: bytes) -> None:
        if not pcm or len(pcm) % 2:
            raise ValueError("PCM audio must be non-empty 16-bit samples")
        chunks = [pcm[offset : offset + 640] for offset in range(0, len(pcm), 640)]
        chunks.extend([b"\x00" * 640] * 50)
        for chunk in chunks:
            await self.provider.send(QwenProtocol.audio_append(chunk))
            if self._pace_audio:
                await asyncio.sleep(len(chunk) / 32_000)

    async def request_delegate(self, pcm: bytes, *, manual: bool) -> ResponseCapture:
        await self.stream_audio(pcm)
        if manual:
            await self.provider.send(QwenProtocol.audio_commit())
            await self.provider.send(QwenProtocol.response_create())
        call_id = ""
        item_id = ""
        arguments = ""
        while True:
            event = await self._receive()
            event_type = str(event.get("type"))
            if event_type == "conversation.item.input_audio_transcription.completed":
                self._record(
                    "provider.user_transcript",
                    actor="user",
                    provider={"item_id": str(event.get("item_id", ""))},
                    purpose="delegate",
                    text=str(event.get("transcript", "")),
                )
            elif event_type == "response.function_call_arguments.done":
                if event.get("name") != "delegate_codex":
                    raise ProviderError("Qwen realtime requested an unexpected tool")
                call_id = str(event.get("call_id", ""))
                item_id = str(event.get("item_id", ""))
                arguments = str(event.get("arguments", ""))
            elif event_type == "response.done":
                response = event.get("response")
                response_id = str(response.get("id", "")) if isinstance(response, dict) else ""
                self._record(
                    "provider.response_done",
                    actor="provider",
                    provider={"response_id": response_id},
                    purpose="delegate_tool",
                )
                break
        if not call_id or not item_id:
            raise ProviderError("Qwen realtime did not request delegate_codex")
        self._record(
            "provider.tool_call",
            actor="provider",
            provider={"item_id": item_id, "call_id": call_id},
            tool="delegate_codex",
            arguments=arguments,
        )
        self.state.delegate_status = "running"
        self.state.summary = "用户委派 Codex 实现一个可以运行的俄罗斯方块游戏。"
        self._record(
            "host.delegate_accepted",
            provider={"call_id": call_id},
            delegate_status="running",
        )
        output_id = f"item_{self._safe_id(self.state.run_id)}_delegate_acceptance"
        output_item = QwenProtocol.function_output_item(
            item_id=output_id,
            call_id=call_id,
            output={
                "status": "accepted",
                "delegate_id": self.state.delegate_id,
                "message": "Nova Audio Agent host owns the background task lifecycle.",
            },
        )
        await self._create_item_and_confirm(output_item)
        await self.provider.send(QwenProtocol.response_create())
        return await self.collect_response(purpose="delegate_ack")

    async def send_audio_query(
        self,
        pcm: bytes,
        *,
        purpose: str,
        manual: bool,
    ) -> ResponseCapture:
        await self.stream_audio(pcm)
        if manual:
            await self.provider.send(QwenProtocol.audio_commit())
            await self.provider.send(QwenProtocol.response_create())
        return await self.collect_response(purpose=purpose)

    def record_provenance_answer(self, response: ResponseCapture) -> None:
        self._record(
            "probe.provenance_answer",
            actor="provider",
            provider={"response_id": response.response_id},
            text=response.transcript,
        )

    async def collect_barge_in(self, pcm: bytes) -> ResponseCapture:
        sent_audio = False
        transcript_seen = False
        transcript_parts: list[str] = []
        progress_response_id = ""
        progress_audio: list[bytes] = []
        progress_usage: dict[str, Any] | None = None
        progress_terminal = False
        while True:
            event = await self._receive()
            event_type = str(event.get("type"))
            if event_type == "response.audio_transcript.delta":
                delta = event.get("delta")
                if isinstance(delta, str):
                    transcript_parts.append(delta)
                progress_response_id = str(event.get("response_id", progress_response_id))
            elif event_type == "response.audio.delta":
                response_id = str(event.get("response_id", ""))
                progress_response_id = response_id or progress_response_id
                delta = event.get("delta")
                if isinstance(delta, str):
                    try:
                        progress_audio.append(base64.b64decode(delta, validate=True))
                    except ValueError as exc:
                        raise ProviderError("Qwen realtime returned invalid base64 audio") from exc
                self._record(
                    "provider.audio_delta",
                    actor="provider",
                    provider={"response_id": response_id},
                    purpose="progress",
                    cause_event_id="progress-1",
                )
                if not sent_audio:
                    self.state.mark_spoken("progress-1")
                    self._record("host.progress_spoken", progress_id="progress-1")
                    self._record("host.barge_in_sent", input_bytes=len(pcm))
                    await self.stream_audio(pcm)
                    sent_audio = True
            elif event_type == "input_audio_buffer.speech_started":
                self._record(
                    "provider.user_speech_started",
                    actor="user",
                    provider={"item_id": str(event.get("item_id", ""))},
                    purpose="barge_in",
                )
            elif event_type == "conversation.item.input_audio_transcription.completed":
                transcript_seen = True
                self._record(
                    "provider.user_transcript",
                    actor="user",
                    provider={"item_id": str(event.get("item_id", ""))},
                    purpose="barge_in",
                    text=str(event.get("transcript", "")),
                )
                if progress_terminal:
                    break
            elif event_type == "response.done":
                response = event.get("response")
                response_id = str(response.get("id", "")) if isinstance(response, dict) else ""
                status = str(response.get("status", "")) if isinstance(response, dict) else ""
                if isinstance(response, dict) and isinstance(response.get("usage"), dict):
                    progress_usage = dict(response["usage"])
                progress_text = "".join(transcript_parts)
                if progress_text:
                    self._record(
                        "assistant.transcript",
                        actor="provider",
                        provider={"response_id": progress_response_id or response_id},
                        purpose="progress",
                        cause_event_id="progress-1",
                        text=progress_text,
                    )
                terminal_kind = (
                    "provider.response_cancelled"
                    if status == "cancelled"
                    else "provider.response_done"
                )
                self._record(
                    terminal_kind,
                    actor="provider",
                    provider={"response_id": response_id},
                    purpose="progress",
                    cause_event_id="progress-1",
                )
                self.last_barge_progress = ResponseCapture(
                    response_id=progress_response_id or response_id,
                    status=status,
                    transcript=progress_text,
                    audio=b"".join(progress_audio),
                    usage=progress_usage,
                )
                progress_terminal = True
                if transcript_seen:
                    break
        if not sent_audio or not transcript_seen:
            raise ProviderError("barge-in audio or transcript evidence is missing")
        return await self.collect_response(purpose="foreground")

    def record_connection_dropped(self) -> None:
        self._record("host.connection_dropped", session_id=self.session_id)

    async def inject_final(self, *, final_id: str, result: str) -> ResponseCapture:
        if self.state.final_id is not None:
            raise ProviderError("final result was already injected")
        self.state.delegate_status = "completed"
        self.state.final_id = final_id
        self.state.final_result = result
        self._record("host.delegate_final", result=result)
        item_id = f"item_{self._safe_id(self.state.run_id)}_{self._safe_id(final_id)}"
        item = QwenProtocol.final_item(
            item_id=item_id,
            run_id=self.state.run_id,
            delegate_id=self.state.delegate_id,
            final_id=final_id,
            result=result,
        )
        self._record(
            "host.final_injected",
            provider={"item_id": item_id},
            final_id=final_id,
        )
        await self._create_item_and_confirm(item)
        await self.provider.send(QwenProtocol.response_create())
        response = await self.collect_response(purpose="final", cause_event_id=final_id)
        if response.status == "completed":
            self._record("host.final_spoken", final_id=final_id)
        return response

    async def close(self) -> None:
        await self.provider.close()
