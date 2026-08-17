"""Provider-neutral realtime adapter composed from Volcengine speech services."""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import AsyncIterator, Callable, Sequence
from typing import Any
from uuid import uuid4

from nova_audio_agent.realtime.protocol import (
    HostContextItem,
    HostResponseIntent,
    ItemIdentity,
    ProviderErrorEvent,
    RealtimeFrontBrainEvent,
    ResponseAudioDelta,
    ResponseCancelRejected,
    ResponseStarted,
    ResponseTerminal,
    ResponseTranscriptDelta,
    ResponseTranscriptFinal,
    SessionIdentity,
    ToolCallReady,
    UserSpeechEnded,
    UserSpeechStarted,
    UserTranscriptDelta,
    UserTranscriptFailed,
    UserTranscriptFinal,
)
from nova_audio_agent.realtime.qwen import GUARD_ACTIVATION_PREFIX
from nova_audio_agent.realtime.telemetry import NullTelemetry, RealtimeTelemetry
from nova_audio_agent.realtime.volcengine.ark import (
    ArkResponseCompleted,
    ArkResponseFailed,
    ArkResponseStarted,
    ArkResponsesError,
    ArkTextDelta,
    ArkToolCall,
    responses_tool_schema,
)
from nova_audio_agent.realtime.volcengine.asr import AsrTranscript
from nova_audio_agent.realtime.volcengine.tts import TextChunker, TtsAudio


class VolcengineRealtimeError(RuntimeError):
    """A safe composite-provider failure."""


class _MixedResponse(RuntimeError):
    pass


_USER_RESPONSE_PENDING_KINDS = frozenset({"recovery", "dialogue_context", "tool_output"})
_CONTEXT_PENDING_KINDS = frozenset({"recovery", "dialogue_context"})
_MAX_CONSUMED_HOST_ITEMS = 256


class VolcengineCascadedAdapter:
    def __init__(
        self,
        *,
        vad: Any,
        asr: Any,
        ark: Any,
        tts: Any,
        telemetry: RealtimeTelemetry | None = None,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        self._vad = vad
        self._asr = asr
        self._ark = ark
        self._tts = tts
        self._telemetry = telemetry or NullTelemetry()
        self._id_factory = (lambda: f"volc_{uuid4().hex}") if id_factory is None else id_factory
        self._epoch = 0
        self._session_id: str | None = None
        self._tools: tuple[dict[str, Any], ...] = ()
        self._pending_items: dict[str, tuple[HostContextItem, dict[str, Any]]] = {}
        self._consumed_host_items: OrderedDict[str, int] = OrderedDict()
        self._consumption_generation = 0
        self._previous_response_id: str | None = None
        self._events: asyncio.Queue[RealtimeFrontBrainEvent | None] = asyncio.Queue()
        self._audio_lock = asyncio.Lock()
        self._asr_session: Any | None = None
        self._asr_task: asyncio.Task[None] | None = None
        self._active_speech_id: str | None = None
        self._active_asr_item_id: str | None = None
        self._response_task: asyncio.Task[None] | None = None
        self._active_response_id: str | None = None
        self._tts_session: Any | None = None
        self._tts_task: asyncio.Task[None] | None = None
        self._tts_texts: list[str] = []
        self._tts_audio_emitted = False
        self._tts_retry_used = False
        self._closed = True

    async def connect(self, *, tools: tuple[dict[str, Any], ...]) -> SessionIdentity:
        if not self._closed:
            raise VolcengineRealtimeError("火山实时会话已经连接")
        self._epoch += 1
        self._session_id = self._id_factory()
        self._tools = tuple(responses_tool_schema(schema) for schema in tools)
        self._pending_items.clear()
        self._consumed_host_items.clear()
        self._consumption_generation = 0
        self._previous_response_id = None
        self._reset_tts_state()
        self._vad.reset()
        # Keep this reconnect queue swap before the first suspension point: close()
        # wakes any getter on the old queue with its sentinel, while the next
        # events() iteration must observe this fresh queue.
        self._events = asyncio.Queue()
        self._closed = False
        self._telemetry.record("volcengine.session.connected", {"epoch": self._epoch})
        return SessionIdentity(self._epoch, self._session_id)

    async def send_audio(self, pcm: bytes) -> None:
        if self._closed:
            raise VolcengineRealtimeError("火山实时会话未连接")
        async with self._audio_lock:
            was_speech = bool(self._vad.in_speech)
            decisions = self._vad.feed(pcm)
            started = next((event for event in decisions if event.kind == "speech_started"), None)
            if started is not None:
                await self._start_asr(started.pre_roll_pcm)
                if started.speech_pcm and self._asr_session is not None:
                    await self._asr_session.append(started.speech_pcm)
            elif was_speech and self._asr_session is not None:
                await self._asr_session.append(pcm)
            stopped = next((event for event in decisions if event.kind == "speech_stopped"), None)
            if stopped is not None:
                await self._stop_asr(commit=stopped.commit)

    async def inject_host_item(
        self,
        item: HostContextItem,
        *,
        confirmation_timeout: float | None = None,
        as_user_activation: bool = False,
    ) -> ItemIdentity:
        del confirmation_timeout
        if self._closed:
            raise VolcengineRealtimeError("火山实时会话未连接")
        if as_user_activation and item.kind not in {"progress", "final"}:
            raise ValueError("user activation requires a progress or final item")
        if item.host_item_id in self._pending_items:
            raise VolcengineRealtimeError("火山实时会话收到重复的宿主项标识")
        provider_item_id = self._id_factory()
        self._pending_items[item.host_item_id] = (
            item,
            _host_input(item, as_user_activation=as_user_activation),
        )
        return ItemIdentity(self._epoch, item.host_item_id, provider_item_id)

    async def create_response(self, intent: HostResponseIntent) -> None:
        if self._closed:
            raise VolcengineRealtimeError("火山实时会话未连接")
        if self._response_task is not None and not self._response_task.done():
            raise VolcengineRealtimeError("火山实时响应仍在进行")
        if self._consume_satisfied_item(intent.item.host_item_id):
            self._response_task = asyncio.create_task(self._run_silent_response())
            return
        inputs = self._take_response_inputs(intent)
        if not inputs:
            raise VolcengineRealtimeError("火山实时响应没有宿主输入")
        self._response_task = asyncio.create_task(self._run_ark(inputs))

    async def cancel_response(self, response_id: str) -> None:
        if type(response_id) is not str or not response_id:
            raise ValueError("response_id must be a non-empty string")
        task = self._response_task
        if task is None or task.done() or self._active_response_id != response_id:
            await self._emit(
                ResponseCancelRejected(
                    self._epoch,
                    response_id,
                    self._id_factory(),
                    "no_active_response",
                )
            )
            return
        task.cancel()
        self._telemetry.record("volcengine.response.cancel", {"epoch": self._epoch})
        await asyncio.gather(task, return_exceptions=True)

    async def events(self) -> AsyncIterator[RealtimeFrontBrainEvent]:
        while True:
            event = await self._events.get()
            if event is None:
                return
            yield event

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        tasks = tuple(
            task
            for task in (self._response_task, self._asr_task, self._tts_task)
            if task is not None and not task.done()
        )
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await self._close_asr()
        await self._cancel_tts()
        self._vad.reset()
        await self._events.put(None)
        self._telemetry.record("volcengine.session.closed", {"epoch": self._epoch})

    async def _start_asr(self, pre_roll_pcm: bytes) -> None:
        if self._asr_session is not None:
            await self._discard_asr()
        speech_id = self._id_factory()
        item_id = self._id_factory()
        try:
            self._telemetry.record("volcengine.asr.connect", {"epoch": self._epoch})
            session = await self._asr.open()
            self._asr_session = session
            self._asr_task = asyncio.create_task(self._consume_asr(item_id, session))
            await session.append(pre_roll_pcm)
        except Exception:
            await self._discard_asr()
            await self._emit(ProviderErrorEvent(self._epoch, "volcengine_asr_start", True))
            return
        self._telemetry.record("volcengine.vad.start", {"epoch": self._epoch})
        self._active_speech_id = speech_id
        self._active_asr_item_id = item_id
        await self._emit(UserSpeechStarted(self._epoch, speech_id, item_id))

    async def _stop_asr(self, *, commit: bool) -> None:
        session = self._asr_session
        if session is None:
            return
        speech_id, self._active_speech_id = self._active_speech_id, None
        if speech_id is None:
            raise VolcengineRealtimeError("豆包 ASR 话语缺少开始标识")
        await self._emit(UserSpeechEnded(self._epoch, speech_id))
        self._telemetry.record("volcengine.vad.end", {"epoch": self._epoch, "commit": commit})
        if not commit:
            await self._discard_asr()
            return
        try:
            await session.finish()
        except Exception:
            item_id = self._active_asr_item_id or self._id_factory()
            await self._emit(ProviderErrorEvent(self._epoch, "volcengine_asr_finish", True))
            await self._emit(UserTranscriptFailed(self._epoch, item_id))
            await self._discard_asr()

    async def _consume_asr(self, item_id: str, session: Any) -> None:
        try:
            async for transcript in session.events():
                assert isinstance(transcript, AsrTranscript)
                if transcript.final:
                    self._telemetry.record("volcengine.asr.final", {"epoch": self._epoch})
                    if not transcript.text.strip():
                        await self._emit(UserTranscriptFailed(self._epoch, item_id))
                        continue
                    await self._emit(UserTranscriptFinal(self._epoch, item_id, transcript.text))
                    await self._start_user_response(transcript.text)
                else:
                    self._telemetry.record("volcengine.asr.partial", {"epoch": self._epoch})
                    await self._emit(UserTranscriptDelta(self._epoch, item_id, transcript.text))
        except asyncio.CancelledError:
            raise
        except Exception:
            await self._emit(ProviderErrorEvent(self._epoch, "volcengine_asr_receive", True))
            await self._emit(UserTranscriptFailed(self._epoch, item_id))
        finally:
            await self._close_asr(session)

    async def _start_user_response(self, text: str) -> None:
        if self._response_task is not None and not self._response_task.done():
            self._response_task.cancel()
            await asyncio.gather(self._response_task, return_exceptions=True)
        pending_inputs, consumed_ids = self._take_user_response_inputs()
        self._mark_items_consumed(consumed_ids)
        self._response_task = asyncio.create_task(
            self._run_ark([*pending_inputs, {"role": "user", "content": text}])
        )

    def _take_response_inputs(self, intent: HostResponseIntent) -> list[dict[str, Any]]:
        target_id = intent.item.host_item_id
        if target_id not in self._pending_items:
            return []
        target_kind = intent.item.kind
        selected: list[dict[str, Any]] = []
        for host_item_id, (item, payload) in tuple(self._pending_items.items()):
            include = host_item_id == target_id or item.kind in _CONTEXT_PENDING_KINDS
            if target_kind == "tool_output" and item.kind == "tool_output":
                include = True
            if include:
                selected.append(payload)
                del self._pending_items[host_item_id]
        return selected

    def _take_user_response_inputs(self) -> tuple[list[dict[str, Any]], tuple[str, ...]]:
        selected: list[dict[str, Any]] = []
        consumed_ids: list[str] = []
        for host_item_id, (item, payload) in tuple(self._pending_items.items()):
            if item.kind not in _USER_RESPONSE_PENDING_KINDS:
                continue
            selected.append(payload)
            consumed_ids.append(host_item_id)
            del self._pending_items[host_item_id]
        return selected, tuple(consumed_ids)

    def _mark_items_consumed(self, host_item_ids: tuple[str, ...]) -> None:
        if not host_item_ids:
            return
        self._consumption_generation += 1
        for host_item_id in host_item_ids:
            self._consumed_host_items[host_item_id] = self._consumption_generation
            self._consumed_host_items.move_to_end(host_item_id)
        while len(self._consumed_host_items) > _MAX_CONSUMED_HOST_ITEMS:
            self._consumed_host_items.popitem(last=False)

    def _consume_satisfied_item(self, host_item_id: str) -> bool:
        generation = self._consumed_host_items.get(host_item_id)
        if generation is None:
            return False
        for item_id, item_generation in tuple(self._consumed_host_items.items()):
            if item_generation == generation:
                del self._consumed_host_items[item_id]
        return True

    async def _run_silent_response(self) -> None:
        response_id = self._id_factory()
        self._active_response_id = response_id
        try:
            await self._emit(ResponseStarted(self._epoch, response_id))
            await self._emit(ResponseTerminal(self._epoch, response_id, "completed", "completed"))
            self._telemetry.record("volcengine.response.terminal", {"status": "completed"})
        finally:
            self._active_response_id = None

    async def _run_ark(self, input_items: Sequence[dict[str, Any]]) -> None:
        response_id: str | None = None
        transcript = ""
        text_seen = False
        first_text_recorded = False
        tool_seen = False
        chunker = TextChunker()
        try:
            async for event in self._ark.stream(
                input_items=input_items,
                tools=self._tools,
                previous_response_id=self._previous_response_id,
            ):
                if isinstance(event, ArkResponseStarted):
                    response_id = event.response_id
                    self._active_response_id = response_id
                    self._telemetry.record("volcengine.llm.started", {"epoch": self._epoch})
                    await self._emit(ResponseStarted(self._epoch, response_id))
                elif isinstance(event, ArkTextDelta):
                    if tool_seen:
                        raise _MixedResponse
                    if response_id is None:
                        raise ArkResponsesError("Ark text arrived before response identity")
                    text_seen = True
                    if not first_text_recorded:
                        first_text_recorded = True
                        self._telemetry.record("volcengine.llm.first_text", {"epoch": self._epoch})
                    transcript += event.text
                    await self._emit(ResponseTranscriptDelta(self._epoch, response_id, event.text))
                    for chunk in chunker.push(event.text):
                        await self._send_tts_text(response_id, chunk)
                elif isinstance(event, ArkToolCall):
                    if text_seen:
                        raise _MixedResponse
                    if response_id is None:
                        raise ArkResponsesError("Ark tool call arrived before response identity")
                    tool_seen = True
                    self._telemetry.record("volcengine.llm.tool_call", {"epoch": self._epoch})
                    await self._emit(
                        ToolCallReady(
                            self._epoch,
                            event.call_id,
                            event.item_id,
                            event.name,
                            event.arguments,
                            response_id,
                        )
                    )
                elif isinstance(event, ArkResponseFailed):
                    response_id = event.response_id
                    raise ArkResponsesError("Ark response failed")
                elif isinstance(event, ArkResponseCompleted):
                    response_id = event.response_id
                    self._previous_response_id = response_id
                    if text_seen:
                        for chunk in chunker.finish():
                            await self._send_tts_text(response_id, chunk)
                        await self._finish_tts()
                        await self._emit(
                            ResponseTranscriptFinal(self._epoch, response_id, transcript)
                        )
                    await self._emit(
                        ResponseTerminal(self._epoch, response_id, "completed", "completed")
                    )
                    self._telemetry.record("volcengine.response.terminal", {"status": "completed"})
                    return
            raise ArkResponsesError("Ark response stream ended without a terminal event")
        except asyncio.CancelledError:
            await self._cancel_tts()
            if response_id is not None:
                await self._emit(
                    ResponseTerminal(self._epoch, response_id, "cancelled", "cancelled")
                )
                self._telemetry.record("volcengine.response.terminal", {"status": "cancelled"})
            return
        except _MixedResponse:
            await self._cancel_tts()
            await self._emit(ProviderErrorEvent(self._epoch, "volcengine_mixed_text_tool", False))
            if response_id is not None:
                await self._emit(
                    ResponseTerminal(self._epoch, response_id, "failed", "mixed_output")
                )
                self._telemetry.record("volcengine.response.terminal", {"status": "failed"})
        except Exception as exc:
            await self._cancel_tts()
            await self._emit(ProviderErrorEvent(self._epoch, "volcengine_response_failed", True))
            terminal_id = response_id or self._id_factory()
            await self._emit(
                ResponseTerminal(
                    self._epoch,
                    terminal_id,
                    "failed",
                    f"provider_{type(exc).__name__}",
                )
            )
            self._telemetry.record("volcengine.response.terminal", {"status": "failed"})
        finally:
            self._active_response_id = None

    async def _send_tts_text(self, response_id: str, text: str) -> None:
        self._tts_texts.append(text)
        try:
            if self._tts_session is None:
                await self._open_tts(response_id)
                self._telemetry.record("volcengine.tts.first_text", {"epoch": self._epoch})
            await self._tts_session.send_text(text)
        except Exception:
            if not await self._retry_tts(response_id):
                raise

    async def _open_tts(self, response_id: str) -> None:
        self._tts_session = await self._tts.open()
        self._tts_task = asyncio.create_task(self._consume_tts(response_id, self._tts_session))

    async def _retry_tts(self, response_id: str) -> bool:
        if self._tts_audio_emitted or self._tts_retry_used:
            return False
        self._tts_retry_used = True
        self._telemetry.record("volcengine.tts.reconnect", {"epoch": self._epoch})
        session, task = self._tts_session, self._tts_task
        self._tts_session = None
        self._tts_task = None
        await self._settle_tts_task(task, report_failure=False)
        if session is not None:
            try:
                await session.close()
            except Exception:
                pass
        await self._open_tts(response_id)
        for pending in self._tts_texts:
            await self._tts_session.send_text(pending)
        return True

    async def _consume_tts(self, response_id: str, session: Any) -> None:
        async for event in session.events():
            assert isinstance(event, TtsAudio)
            if not self._tts_audio_emitted:
                self._tts_audio_emitted = True
                self._telemetry.record("volcengine.tts.first_audio", {"epoch": self._epoch})
            await self._emit(ResponseAudioDelta(self._epoch, response_id, event.pcm))

    async def _finish_tts(self) -> None:
        session = self._tts_session
        if session is None:
            return
        try:
            await session.finish()
            if self._tts_task is not None:
                await self._tts_task
        except Exception:
            if not await self._retry_tts(self._active_response_id or self._id_factory()):
                raise
            assert self._tts_session is not None
            await self._tts_session.finish()
            if self._tts_task is not None:
                await self._tts_task
        finally:
            session = self._tts_session
            self._tts_session = None
            self._tts_task = None
            if session is not None:
                try:
                    await session.close()
                except Exception:
                    pass
                self._reset_tts_state()

    async def _cancel_tts(self) -> None:
        session, task = self._tts_session, self._tts_task
        self._tts_session = None
        self._tts_task = None
        if session is not None:
            try:
                await session.cancel()
            except Exception:
                pass
        await self._settle_tts_task(task, report_failure=True)
        if session is not None:
            try:
                await session.close()
            except Exception:
                pass
        if session is not None or task is not None:
            self._telemetry.record("volcengine.tts.cancel", {"epoch": self._epoch})
        self._reset_tts_state()

    async def _settle_tts_task(
        self, task: asyncio.Task[None] | None, *, report_failure: bool
    ) -> None:
        if task is None:
            return
        if not task.done():
            task.cancel()
        result = (await asyncio.gather(task, return_exceptions=True))[0]
        if isinstance(result, BaseException) and not isinstance(result, asyncio.CancelledError):
            self._telemetry.record("volcengine.tts.receive_error", {"epoch": self._epoch})
            if report_failure:
                await self._emit(ProviderErrorEvent(self._epoch, "volcengine_tts_receive", True))

    def _reset_tts_state(self) -> None:
        self._tts_texts.clear()
        self._tts_audio_emitted = False
        self._tts_retry_used = False

    async def _discard_asr(self) -> None:
        session = self._asr_session
        task, self._asr_task = self._asr_task, None
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if session is not None and self._asr_session is session:
            await self._close_asr(session)

    async def _close_asr(self, session: Any | None = None) -> None:
        session = self._asr_session if session is None else session
        if session is not None and self._asr_session is session:
            self._asr_session = None
            self._active_asr_item_id = None
        if session is not None:
            try:
                await session.close()
            except Exception:
                pass

    async def _emit(self, event: RealtimeFrontBrainEvent) -> None:
        await self._events.put(event)


def _host_input(item: HostContextItem, *, as_user_activation: bool) -> dict[str, Any]:
    if item.kind == "tool_output":
        return {
            "type": "function_call_output",
            "call_id": item.call_id,
            "output": item.content,
        }
    labels = {
        "progress": "任务进度事实",
        "final": "任务结果事实",
        "recovery": "恢复摘要",
        "dialogue_context": "只读历史对话",
    }
    if as_user_activation:
        content = (
            f"{GUARD_ACTIVATION_PREFIX}以下内容不是用户说的话，也不是新的用户目标。"
            f"只把该事实作为宿主提供的上下文：{item.content}"
        )
    else:
        content = f"Nova Audio Agent {labels[item.kind]}：{item.content}"
    return {"role": "user" if as_user_activation else "system", "content": content}
