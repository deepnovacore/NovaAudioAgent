from __future__ import annotations

import asyncio
import base64
from datetime import datetime
import json
from pathlib import Path
from types import SimpleNamespace
import wave

import pytest

from scripts.realtime_probe.interruption import execute_smart_cancel
from scripts.realtime_probe import interruption, live
from scripts.realtime_probe.fixtures import FIXTURE_TEXT
from scripts.realtime_probe.live import execute_full, execute_phase_a
from scripts.realtime_probe.models import HostState
from scripts.realtime_probe.playback import RealtimePcmSink
from scripts.realtime_probe.provider import ProviderError
from scripts.realtime_probe.runner import RealtimeProbeSession
from scripts.realtime_probe.scenario import build_scenario


async def _virtual_playback_sleep(seconds: float) -> None:
    del seconds
    await asyncio.sleep(0)


def _deterministic_sink() -> RealtimePcmSink:
    return RealtimePcmSink(sleep=_virtual_playback_sleep)


class ScriptedPhaseAProvider:
    def __init__(self) -> None:
        self.sent: list[dict[str, object]] = []
        self.incoming: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        self.pending_item: dict[str, object] | None = None
        self.audio_turns = 0
        self.response_count = 0
        self.closed = False

    async def connect(self) -> dict[str, object]:
        return {"type": "session.created", "session": {"id": "session-phase-a"}}

    async def send(self, event: dict[str, object]) -> None:
        self.sent.append(event)
        event_type = event["type"]
        if event_type == "session.update":
            await self.incoming.put(
                {"type": "session.updated", "session": {"id": "session-phase-a"}}
            )
        elif event_type == "input_audio_buffer.commit":
            self.audio_turns += 1
        elif event_type == "conversation.item.create":
            item = event["item"]
            assert isinstance(item, dict)
            self.pending_item = item
            await self.incoming.put({"type": "conversation.item.created", "item": item})
        elif event_type == "response.create":
            self.response_count += 1
            await self._queue_response()

    async def _queue_response(self) -> None:
        if self.response_count == 1:
            await self.incoming.put(
                {
                    "type": "conversation.item.input_audio_transcription.completed",
                    "item_id": "user-item-1",
                    "transcript": "请让 Codex 写一个可以运行的俄罗斯方块游戏。",
                }
            )
            await self.incoming.put(
                {
                    "type": "response.function_call_arguments.done",
                    "item_id": "tool-item-1",
                    "call_id": "call-1",
                    "name": "delegate_codex",
                    "arguments": json.dumps({"objective": "实现俄罗斯方块"}, ensure_ascii=False),
                }
            )
            await self.incoming.put(
                {
                    "type": "response.done",
                    "response": {"id": "response-tool", "status": "completed"},
                }
            )
            return
        item = self.pending_item or {}
        item_type = item.get("type")
        item_id = str(item.get("id", ""))
        if item_type == "function_call_output":
            transcript = "已交给 Codex，我会同步可靠进度。"
            response_id = "response-ack"
        elif "progress-1" in item_id:
            transcript = "Codex 刚完成了页面骨架。"
            response_id = "response-progress-1"
        elif "progress-2" in item_id:
            transcript = "Codex 刚完成了碰撞检测与旋转逻辑。"
            response_id = "response-progress-2"
        elif "progress-3" in item_id:
            transcript = "Codex 刚完成了键盘控制与计分。"
            response_id = "response-progress-3"
        else:
            transcript = "这些是 Codex 的后台进度，不是你说的。"
            response_id = "response-provenance"
        await self.incoming.put(
            {
                "type": "response.audio.delta",
                "response_id": response_id,
                "delta": "AAA=",
            }
        )
        await self.incoming.put(
            {
                "type": "response.audio_transcript.done",
                "response_id": response_id,
                "transcript": transcript,
            }
        )
        await self.incoming.put(
            {
                "type": "response.done",
                "response": {
                    "id": response_id,
                    "status": "completed",
                    "usage": {"input_tokens": 10, "output_tokens": 5},
                },
            }
        )
        self.pending_item = None

    async def receive(self) -> dict[str, object]:
        return await self.incoming.get()

    async def close(self) -> None:
        self.closed = True


class ScriptedFullProvider:
    def __init__(self, *, reconnect: bool = False) -> None:
        self.reconnect = reconnect
        self.sent: list[dict[str, object]] = []
        self.incoming: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        self.pending_item: dict[str, object] | None = None
        self.closed = False
        self.tool_requested = reconnect
        self.active_progress = False
        self.barge_queued = False
        self.cancel_sent = False
        self.query_number = 0
        self.query_audio_seen = False

    async def connect(self) -> dict[str, object]:
        suffix = "2" if self.reconnect else "1"
        return {"type": "session.created", "session": {"id": f"session-full-{suffix}"}}

    async def send(self, event: dict[str, object]) -> None:
        self.sent.append(event)
        event_type = event["type"]
        if event_type == "session.update":
            suffix = "2" if self.reconnect else "1"
            await self.incoming.put(
                {"type": "session.updated", "session": {"id": f"session-full-{suffix}"}}
            )
        elif event_type == "conversation.item.create":
            item = event["item"]
            assert isinstance(item, dict)
            self.pending_item = item
            await self.incoming.put({"type": "conversation.item.created", "item": item})
            if "recovery" in str(item.get("id", "")):
                self.pending_item = None
        elif event_type == "response.create":
            await self._queue_manual_response()
        elif event_type == "response.cancel":
            self.cancel_sent = True
            self.active_progress = False
            await self.incoming.put(
                {
                    "type": "response.done",
                    "response": {
                        "id": "response-progress-1",
                        "status": "cancelled",
                        "status_details": {"reason": "client_cancelled"},
                        "usage": {"input_tokens": 2, "output_tokens": 1},
                    },
                }
            )
        elif event_type == "input_audio_buffer.append":
            if self.cancel_sent and not self.barge_queued:
                self.barge_queued = True
                await self.incoming.put(
                    {"type": "input_audio_buffer.speech_started", "item_id": "barge-item"}
                )
                await self._queue_spoken_response("response-foreground", "七乘八等于五十六。")
                await self.incoming.put(
                    {
                        "type": "conversation.item.input_audio_transcription.completed",
                        "item_id": "barge-item",
                        "transcript": "顺便问一下，七乘八是多少？",
                    }
                )
            elif self.active_progress and not self.barge_queued:
                self.barge_queued = True
                await self.incoming.put(
                    {"type": "input_audio_buffer.speech_started", "item_id": "barge-item"}
                )
                await self.incoming.put(
                    {
                        "type": "conversation.item.input_audio_transcription.completed",
                        "item_id": "barge-item",
                        "transcript": "顺便问一下，七乘八是多少？",
                    }
                )
                await self.incoming.put(
                    {
                        "type": "response.done",
                        "response": {"id": "response-progress-1", "status": "cancelled"},
                    }
                )
                await self._queue_spoken_response("response-foreground", "七乘八等于五十六。")
            elif self.reconnect and self.pending_item is None:
                self.query_audio_seen = True

    async def _queue_manual_response(self) -> None:
        item = self.pending_item or {}
        item_id = str(item.get("id", ""))
        if item.get("type") == "function_call_output":
            await self._queue_spoken_response(
                "response-ack", "Codex 后台已接受任务，正在编写俄罗斯方块游戏。"
            )
        elif "progress-1" in item_id:
            self.active_progress = True
            await self.incoming.put(
                {
                    "type": "response.audio_transcript.delta",
                    "response_id": "response-progress-1",
                    "delta": "Codex 后台进度：已完成俄罗斯方块的页面骨架。",
                }
            )
            await self.incoming.put(
                {
                    "type": "response.audio.delta",
                    "response_id": "response-progress-1",
                    "delta": base64.b64encode(b"\x00\x00" * 480).decode("ascii"),
                }
            )
            return
        elif "progress-2" in item_id:
            await self._queue_spoken_response(
                "response-progress-2", "Codex 后台进度：已完成方块碰撞检测与旋转逻辑。"
            )
        elif "progress-3" in item_id:
            await self._queue_spoken_response(
                "response-progress-3", "Codex 后台进度：已完成键盘控制与计分，正在做最终检查。"
            )
        elif "final" in item_id:
            await self._queue_spoken_response(
                "response-final", "Codex 后台结果：俄罗斯方块已完成，交付单文件 index.html。"
            )
        self.pending_item = None

    async def _queue_spoken_response(self, response_id: str, transcript: str) -> None:
        await self.incoming.put(
            {"type": "response.audio.delta", "response_id": response_id, "delta": "AAA="}
        )
        await self.incoming.put(
            {
                "type": "response.audio_transcript.done",
                "response_id": response_id,
                "transcript": transcript,
            }
        )
        await self.incoming.put(
            {
                "type": "response.done",
                "response": {
                    "id": response_id,
                    "status": "completed",
                    "usage": {"input_tokens": 2, "output_tokens": 1},
                },
            }
        )

    async def receive(self) -> dict[str, object]:
        if self.incoming.empty() and not self.tool_requested:
            self.tool_requested = True
            await self.incoming.put(
                {
                    "type": "conversation.item.input_audio_transcription.completed",
                    "item_id": "delegate-user-item",
                    "transcript": "请让 Codex 写一个可以运行的俄罗斯方块游戏。",
                }
            )
            await self.incoming.put(
                {
                    "type": "response.function_call_arguments.done",
                    "item_id": "delegate-tool-item",
                    "call_id": "delegate-call",
                    "name": "delegate_codex",
                    "arguments": '{"objective":"实现俄罗斯方块"}',
                }
            )
            await self.incoming.put(
                {
                    "type": "response.done",
                    "response": {"id": "response-tool", "status": "completed"},
                }
            )
        elif self.incoming.empty() and self.reconnect and self.query_audio_seen:
            self.query_audio_seen = False
            self.query_number += 1
            if self.query_number == 1:
                await self.incoming.put(
                    {
                        "type": "conversation.item.input_audio_transcription.completed",
                        "item_id": "recovery-user-item",
                        "transcript": "刚才委派的任务还在进行吗？",
                    }
                )
                await self._queue_spoken_response(
                    "response-recovery", "俄罗斯方块任务仍在进行，我会等待可靠结果。"
                )
            else:
                await self.incoming.put(
                    {
                        "type": "conversation.item.input_audio_transcription.completed",
                        "item_id": "followup-user-item",
                        "transcript": "刚才委派的是什么任务，最终交付了什么？",
                    }
                )
                await self._queue_spoken_response(
                    "response-followup",
                    "刚才委派的是俄罗斯方块，最终交付了单文件 index.html。",
                )
        return await self.incoming.get()

    async def close(self) -> None:
        self.closed = True


class FailingRecoveredProvider(ScriptedFullProvider):
    def __init__(self) -> None:
        super().__init__(reconnect=True)

    async def send(self, event: dict[str, object]) -> None:
        if event["type"] == "input_audio_buffer.append":
            raise ProviderError("synthetic recovered-session failure")
        await super().send(event)


class SemanticFailingCloseRecoveredProvider(ScriptedFullProvider):
    def __init__(self) -> None:
        super().__init__(reconnect=True)

    async def receive(self) -> dict[str, object]:
        event = await super().receive()
        if (
            event.get("type") == "response.audio_transcript.done"
            and event.get("response_id") == "response-followup"
        ):
            return {**event, "transcript": "刚才委派的是另一个任务，最终交付内容未知。"}
        return event

    async def close(self) -> None:
        self.closed = True
        raise RuntimeError("recovered close secret-key payload")


class FailingConnectProvider:
    async def connect(self) -> dict[str, object]:
        raise ProviderError("secret-key payload must not be persisted")

    async def send(self, event: dict[str, object]) -> None:
        raise AssertionError("send must not run after connect failure")

    async def receive(self) -> dict[str, object]:
        raise AssertionError("receive must not run after connect failure")

    async def close(self) -> None:
        pass


class RuntimeFailingConnectProvider(FailingConnectProvider):
    async def connect(self) -> dict[str, object]:
        raise RuntimeError("connect secret-key payload")


class ReasonCodedFailingConnectProvider(FailingConnectProvider):
    async def connect(self) -> dict[str, object]:
        raise ProviderError(
            "Qwen realtime websocket connection failed",
            reason_code="qwen_connection_failed",
        )


class ScriptedInterruptionProvider:
    def __init__(self) -> None:
        self.sent: list[dict[str, object]] = []
        self.incoming: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        self.pending_item: dict[str, object] | None = None
        self.closed = False
        self.tool_requested = False
        self.progress_started = False
        self.cancel_sent = False
        self.barge_queued = False
        self.receive_during_barge_send = False
        self._speech_delivered = asyncio.Event()
        self._receiving = False

    async def connect(self) -> dict[str, object]:
        return {"type": "session.created", "session": {"id": "session-interruption"}}

    async def send(self, event: dict[str, object]) -> None:
        self.sent.append(event)
        event_type = event["type"]
        if event_type == "session.update":
            await self.incoming.put(
                {"type": "session.updated", "session": {"id": "session-interruption"}}
            )
        elif event_type == "conversation.item.create":
            item = event["item"]
            assert isinstance(item, dict)
            self.pending_item = item
            await self.incoming.put({"type": "conversation.item.created", "item": item})
        elif event_type == "response.create":
            await self._queue_response()
        elif event_type == "response.cancel":
            self.cancel_sent = True
            await self.incoming.put(
                {
                    "type": "response.done",
                    "response": {
                        "id": "response-progress",
                        "status": "cancelled",
                        "status_details": {"reason": "client_cancelled"},
                        "output": [{"id": "item-progress-output"}],
                        "usage": {
                            "input_tokens": 20,
                            "output_tokens": 2,
                            "cached": False,
                        },
                    },
                }
            )
        elif (
            event_type == "input_audio_buffer.append"
            and self.progress_started
            and self.cancel_sent
            and not self.barge_queued
        ):
            self.barge_queued = True
            await self.incoming.put(
                {"type": "input_audio_buffer.speech_started", "item_id": "item-barge"}
            )
            await self._queue_barge_response(
                "response-foreground",
                "item-foreground-output",
                "七乘八等于五十六。",
            )
            await self.incoming.put(
                {
                    "type": "conversation.item.input_audio_transcription.completed",
                    "item_id": "item-barge",
                    "transcript": "顺便问一下，七乘八是多少？",
                }
            )
            await self._speech_delivered.wait()
            self.receive_during_barge_send = True

    async def _queue_response(self) -> None:
        item = self.pending_item or {}
        item_id = str(item.get("id", ""))
        if item.get("type") == "function_call_output":
            await self._queue_spoken_response(
                "response-ack",
                "item-ack-output",
                "已交给 Codex，我会同步可靠进度。",
            )
            self.pending_item = None
        elif "progress-1" in item_id:
            self.progress_started = True
            pcm = b"\x01\x00" * 480
            await self.incoming.put(
                {
                    "type": "response.audio_transcript.delta",
                    "response_id": "response-progress",
                    "item_id": "item-progress-output",
                    "delta": "Codex 后台进度：已完成俄罗斯方块的页面骨架。",
                }
            )
            await self.incoming.put(
                {
                    "type": "response.audio.delta",
                    "response_id": "response-progress",
                    "item_id": "item-progress-output",
                    "delta": base64.b64encode(pcm).decode("ascii"),
                }
            )
            self.pending_item = None

    async def _queue_barge_response(self, response_id: str, item_id: str, transcript: str) -> None:
        await self._queue_spoken_response(response_id, item_id, transcript)

    async def _queue_spoken_response(self, response_id: str, item_id: str, transcript: str) -> None:
        pcm = b"\x02\x00" * 480
        await self.incoming.put(
            {
                "type": "response.audio.delta",
                "response_id": response_id,
                "item_id": item_id,
                "delta": base64.b64encode(pcm).decode("ascii"),
            }
        )
        await self.incoming.put(
            {
                "type": "response.audio_transcript.done",
                "response_id": response_id,
                "item_id": item_id,
                "transcript": transcript,
            }
        )
        await self.incoming.put(
            {
                "type": "response.done",
                "response": {
                    "id": response_id,
                    "status": "completed",
                    "output": [{"id": item_id}],
                    "usage": (
                        {
                            "input_tokens": 10,
                            "output_tokens": 1,
                            "cached": True,
                        }
                        if response_id == "response-ack"
                        else {
                            "input_tokens": 30,
                            "output_tokens": 3,
                            "cached": False,
                        }
                    ),
                },
            }
        )

    async def receive(self) -> dict[str, object]:
        if self._receiving:
            raise AssertionError("provider.receive called concurrently")
        self._receiving = True
        try:
            if self.incoming.empty() and not self.tool_requested:
                self.tool_requested = True
                await self.incoming.put(
                    {
                        "type": "conversation.item.input_audio_transcription.completed",
                        "item_id": "item-delegate-user",
                        "transcript": "请让 Codex 写一个可以运行的俄罗斯方块游戏。",
                    }
                )
                await self.incoming.put(
                    {
                        "type": "response.function_call_arguments.done",
                        "item_id": "item-delegate-tool",
                        "call_id": "call-delegate",
                        "name": "delegate_codex",
                        "arguments": '{"objective":"实现俄罗斯方块"}',
                    }
                )
                await self.incoming.put(
                    {
                        "type": "response.done",
                        "response": {"id": "response-tool", "status": "completed"},
                    }
                )
            event = await self.incoming.get()
            if event["type"] == "input_audio_buffer.speech_started":
                self._speech_delivered.set()
            return event
        finally:
            self._receiving = False

    async def close(self) -> None:
        self.closed = True


class ScriptedAutoCancelBaselineProvider:
    def __init__(self) -> None:
        self.sent: list[dict[str, object]] = []
        self.incoming: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        self.target_started = False
        self.target_terminal_queued = False
        self.pending_guard_item: dict[str, object] | None = None
        self.closed = False

    async def connect(self) -> dict[str, object]:
        return {"type": "session.created", "session": {"id": "session-auto-baseline"}}

    async def send(self, event: dict[str, object]) -> None:
        self.sent.append(event)
        event_type = event["type"]
        if event_type == "session.update":
            await self.incoming.put(
                {"type": "session.updated", "session": {"id": "session-auto-baseline"}}
            )
        elif event_type == "input_audio_buffer.append" and not self.target_started:
            self.target_started = True
            await self.incoming.put(
                {
                    "type": "conversation.item.input_audio_transcription.completed",
                    "item_id": "item-auto-user",
                    "transcript": "七乘八是多少？",
                }
            )
            await self.incoming.put(
                {
                    "type": "response.audio.delta",
                    "response_id": "response-auto",
                    "item_id": "item-auto-output",
                    "delta": base64.b64encode(b"\x01\x00" * 480).decode("ascii"),
                }
            )
        elif event_type == "response.cancel":
            await self.incoming.put(
                {
                    "type": "probe.response_cancel_rejected",
                    "reason": "no_active_response",
                }
            )
            await self.incoming.put(
                {
                    "type": "response.audio.delta",
                    "response_id": "response-auto",
                    "item_id": "item-auto-output",
                    "delta": base64.b64encode(b"\x02\x00" * 480).decode("ascii"),
                }
            )
            await self.incoming.put(
                {
                    "type": "response.audio_transcript.done",
                    "response_id": "response-auto",
                    "item_id": "item-auto-output",
                    "transcript": "七乘八等于五十六。",
                }
            )
            await self.incoming.put(
                {
                    "type": "response.done",
                    "response": {
                        "id": "response-auto",
                        "status": "completed",
                        "output": [{"id": "item-auto-output"}],
                    },
                }
            )
            self.target_terminal_queued = True
        elif event_type == "conversation.item.create":
            assert self.target_terminal_queued is True
            item = event["item"]
            assert isinstance(item, dict)
            self.pending_guard_item = item
            await self.incoming.put({"type": "conversation.item.created", "item": item})
        elif event_type == "response.create":
            assert self.pending_guard_item is not None
            await self.incoming.put(
                {
                    "type": "response.audio.delta",
                    "response_id": "response-guard",
                    "item_id": "item-guard-output",
                    "delta": base64.b64encode(b"\x03\x00" * 480).decode("ascii"),
                }
            )
            await self.incoming.put(
                {
                    "type": "response.audio_transcript.done",
                    "response_id": "response-guard",
                    "item_id": "item-guard-output",
                    "transcript": "小心水杯正在倾倒。",
                }
            )
            await self.incoming.put(
                {
                    "type": "response.done",
                    "response": {"id": "response-guard", "status": "completed"},
                }
            )

    async def receive(self) -> dict[str, object]:
        return await self.incoming.get()

    async def close(self) -> None:
        self.closed = True


class LateDelegateTranscriptProvider(ScriptedInterruptionProvider):
    async def _queue_response(self) -> None:
        item_id = str((self.pending_item or {}).get("id", ""))
        if "progress-1" in item_id:
            await self.incoming.put(
                {
                    "type": "conversation.item.input_audio_transcription.completed",
                    "item_id": "delegate-user-item-late",
                    "transcript": "请让 Codex 写一个可以运行的俄罗斯方块游戏。",
                }
            )
        await super()._queue_response()


class CompletedAfterCancelProvider(ScriptedInterruptionProvider):
    async def send(self, event: dict[str, object]) -> None:
        if event["type"] != "response.cancel":
            await super().send(event)
            return
        self.sent.append(event)
        self.cancel_sent = True
        await self.incoming.put(
            {
                "type": "response.done",
                "response": {
                    "id": "response-progress",
                    "status": "completed",
                    "status_details": {"reason": "natural_completion"},
                    "output": [{"id": "item-progress-output"}],
                },
            }
        )


class RuntimeFailingSemanticCloseProvider(CompletedAfterCancelProvider):
    async def close(self) -> None:
        raise RuntimeError("close secret-key payload")


class ExplodingCancelProvider(ScriptedInterruptionProvider):
    async def send(self, event: dict[str, object]) -> None:
        if event["type"] == "response.cancel":
            self.sent.append(event)
            raise RuntimeError("secret-dashscope-key payload={'audio':'private'}")
        await super().send(event)


class MissingCancelTerminalProvider(ScriptedInterruptionProvider):
    async def send(self, event: dict[str, object]) -> None:
        if event["type"] != "response.cancel":
            await super().send(event)
            return
        self.sent.append(event)
        self.cancel_sent = True


class ProgressWithoutAudioProvider(ScriptedInterruptionProvider):
    async def _queue_response(self) -> None:
        item = self.pending_item or {}
        item_id = str(item.get("id", ""))
        if "progress-1" not in item_id:
            await super()._queue_response()
            return
        self.progress_started = True
        await self.incoming.put(
            {
                "type": "response.done",
                "response": {
                    "id": "response-progress",
                    "status": "failed",
                    "status_details": {"reason": "guardrail"},
                },
            }
        )
        self.pending_item = None


class TerminalDuringCancelSendProvider(ScriptedInterruptionProvider):
    def __init__(self) -> None:
        super().__init__()
        self.terminal_received_during_cancel_send = False
        self._cancel_terminal_delivered = asyncio.Event()

    async def send(self, event: dict[str, object]) -> None:
        if event["type"] != "response.cancel":
            await super().send(event)
            return
        self.sent.append(event)
        self.cancel_sent = True
        await self.incoming.put(
            {
                "type": "response.done",
                "response": {
                    "id": "response-progress",
                    "status": "cancelled",
                    "status_details": {"reason": "client_cancelled"},
                },
            }
        )
        await self._cancel_terminal_delivered.wait()
        self.terminal_received_during_cancel_send = True

    async def receive(self) -> dict[str, object]:
        event = await super().receive()
        response = event.get("response")
        if (
            event["type"] == "response.done"
            and isinstance(response, dict)
            and response.get("id") == "response-progress"
        ):
            self._cancel_terminal_delivered.set()
        return event


class DeltaTerminalThenTranscriptProvider(ScriptedInterruptionProvider):
    async def _queue_barge_response(self, response_id: str, item_id: str, transcript: str) -> None:
        pcm = b"\x02\x00" * 480
        await self.incoming.put(
            {
                "type": "response.audio.delta",
                "response_id": response_id,
                "item_id": item_id,
                "delta": base64.b64encode(pcm).decode("ascii"),
            }
        )
        await self.incoming.put(
            {
                "type": "response.audio_transcript.delta",
                "response_id": response_id,
                "item_id": item_id,
                "delta": "七乘八等于",
            }
        )
        await self.incoming.put(
            {
                "type": "response.done",
                "response": {
                    "id": response_id,
                    "status": "completed",
                    "output": [{"id": item_id}],
                },
            }
        )
        await self.incoming.put(
            {
                "type": "response.audio_transcript.done",
                "response_id": response_id,
                "item_id": item_id,
                "transcript": transcript,
            }
        )


class TerminalThenTranscriptProvider(ScriptedInterruptionProvider):
    async def _queue_barge_response(self, response_id: str, item_id: str, transcript: str) -> None:
        pcm = b"\x02\x00" * 480
        await self.incoming.put(
            {
                "type": "response.audio.delta",
                "response_id": response_id,
                "item_id": item_id,
                "delta": base64.b64encode(pcm).decode("ascii"),
            }
        )
        await self.incoming.put(
            {
                "type": "response.done",
                "response": {
                    "id": response_id,
                    "status": "completed",
                    "output": [{"id": item_id}],
                },
            }
        )
        await self.incoming.put(
            {
                "type": "response.audio_transcript.done",
                "response_id": response_id,
                "item_id": item_id,
                "transcript": transcript,
            }
        )


class OutputTranscriptFallbackProvider(ScriptedInterruptionProvider):
    async def _queue_barge_response(self, response_id: str, item_id: str, transcript: str) -> None:
        pcm = b"\x02\x00" * 480
        await self.incoming.put(
            {
                "type": "response.audio.delta",
                "response_id": response_id,
                "item_id": item_id,
                "delta": base64.b64encode(pcm).decode("ascii"),
            }
        )
        await self.incoming.put(
            {
                "type": "response.done",
                "response": {
                    "id": response_id,
                    "status": "completed",
                    "output": [
                        {
                            "id": item_id,
                            "content": [{"type": "audio", "transcript": transcript}],
                        }
                    ],
                },
            }
        )


class OutputItemOnlyProgressProvider(TerminalDuringCancelSendProvider):
    async def _queue_response(self) -> None:
        item = self.pending_item or {}
        item_id = str(item.get("id", ""))
        if "progress-1" not in item_id:
            await super()._queue_response()
            return
        self.progress_started = True
        await self.incoming.put(
            {
                "type": "response.output_item.added",
                "response_id": "response-progress",
                "item": {"id": "item-progress-output", "type": "message"},
            }
        )
        await self.incoming.put(
            {
                "type": "response.audio_transcript.delta",
                "response_id": "response-progress",
                "delta": "Codex 后台进度：已完成俄罗斯方块的页面骨架。",
            }
        )
        pcm = b"\x01\x00" * 480
        await self.incoming.put(
            {
                "type": "response.audio.delta",
                "response_id": "response-progress",
                "delta": base64.b64encode(pcm).decode("ascii"),
            }
        )
        self.pending_item = None


class LateAckBeforeProgressProvider(ScriptedInterruptionProvider):
    async def _queue_response(self) -> None:
        item = self.pending_item or {}
        item_id = str(item.get("id", ""))
        if "progress-1" not in item_id:
            await super()._queue_response()
            return
        self.progress_started = True
        await self.incoming.put(
            {
                "type": "response.audio_transcript.done",
                "response_id": "response-ack",
                "item_id": "item-ack-output",
                "transcript": "已交给 Codex，我会同步可靠进度。",
            }
        )
        await self.incoming.put(
            {
                "type": "response.done",
                "response": {
                    "id": "response-ack",
                    "status": "completed",
                    "output": [{"id": "item-ack-output"}],
                },
            }
        )
        pcm = b"\x01\x00" * 480
        await self.incoming.put(
            {
                "type": "response.audio_transcript.delta",
                "response_id": "response-progress",
                "item_id": "item-progress-output",
                "delta": "Codex 后台进度：已完成俄罗斯方块的页面骨架。",
            }
        )
        await self.incoming.put(
            {
                "type": "response.audio.delta",
                "response_id": "response-progress",
                "item_id": "item-progress-output",
                "delta": base64.b64encode(pcm).decode("ascii"),
            }
        )
        self.pending_item = None


class TrackingSink(RealtimePcmSink):
    def __init__(self) -> None:
        super().__init__(sleep=_virtual_playback_sleep)
        self.finished_called = False
        self.run_started = asyncio.Event()
        self.run_exited = asyncio.Event()

    async def run(self) -> None:
        self.run_started.set()
        try:
            await super().run()
        finally:
            self.run_exited.set()

    async def finish(self) -> None:
        self.finished_called = True
        await super().finish()


class FailingFinishSink(TrackingSink):
    async def finish(self) -> None:
        self.finished_called = True
        raise RuntimeError("cleanup secret-key payload")


@pytest.mark.asyncio
async def test_phase_a_executes_the_exact_live_path_and_passes() -> None:
    provider = ScriptedPhaseAProvider()
    state = HostState(run_id="run-phase-a", delegate_id="delegate-phase-a")
    session = RealtimeProbeSession(provider=provider, state=state)
    fixture = b"\x00\x00" * 1600

    outcome = await execute_phase_a(
        session,
        {
            "delegate_request": fixture,
            "provenance_question": fixture,
        },
        nonces=["nonce-1", "nonce-2", "nonce-3"],
    )

    assert outcome.report.status == "pass"
    assert state.delegate_status == "running"
    assert state.injected_progress_ids == ["progress-1", "progress-2", "progress-3"]
    assert state.spoken_progress_ids == ["progress-1", "progress-2", "progress-3"]
    assert outcome.report.metrics["usage"]["input_tokens"] == 50
    assert len(outcome.audio) == 5
    commands = [event["type"] for event in provider.sent]
    assert commands.count("conversation.item.create") == 4
    assert commands.count("response.create") == 6
    assert any(event.kind == "provider.tool_call" for event in outcome.events)
    assert any(event.kind == "probe.provenance_answer" for event in outcome.events)


@pytest.mark.asyncio
async def test_smart_cancel_runs_receive_playback_and_input_concurrently() -> None:
    provider = ScriptedInterruptionProvider()
    state = HostState(run_id="run-interrupt", delegate_id="delegate-interrupt")
    session = RealtimeProbeSession(provider=provider, state=state, pace_audio=False)
    fixture = b"\x01\x00" * 640

    outcome = await execute_smart_cancel(
        session,
        {"delegate_request": fixture, "barge_in": fixture},
        sink_factory=_deterministic_sink,
    )

    assert outcome.report.status == "pass"
    sent_types = [event["type"] for event in provider.sent]
    cancel_index = sent_types.index("response.cancel")
    first_barge_append = sent_types.index("input_audio_buffer.append", cancel_index)
    assert cancel_index < first_barge_append
    assert provider.receive_during_barge_send is True
    assert state.delegate_status == "running"
    assert outcome.audio["progress_rendered"]
    assert outcome.audio["foreground"]
    assert outcome.raw_provider_events
    assert not any(
        event.kind == "provider.audio_delta"
        and event.data.get("purpose") == "progress"
        and event.provider.get("response_id") == "response-foreground"
        for event in outcome.events
    )
    progress_audio = next(
        event
        for event in outcome.events
        if event.kind == "provider.audio_delta" and event.data.get("purpose") == "progress"
    )
    foreground_audio = next(
        event
        for event in outcome.events
        if event.kind == "provider.audio_delta" and event.data.get("purpose") == "foreground"
    )
    barge_transcript = next(
        event
        for event in outcome.events
        if event.kind == "provider.user_transcript" and event.data.get("purpose") == "barge_in"
    )
    cancelled = next(
        event for event in outcome.events if event.kind == "provider.response_cancelled"
    )
    assert progress_audio.provider == {
        "response_id": "response-progress",
        "item_id": "item-progress-output",
    }
    assert foreground_audio.provider == {
        "response_id": "response-foreground",
        "item_id": "item-foreground-output",
    }
    assert foreground_audio.t_ms < barge_transcript.t_ms
    assert cancelled.provider["item_id"] == "item-progress-output"
    assert cancelled.data["status"] == "cancelled"
    assert cancelled.data["status_details"] == {"reason": "client_cancelled"}
    assert cancelled.data["output_item_ids"] == ["item-progress-output"]
    assert not any(event.kind == "host.delegate_cancelled" for event in outcome.events)
    expected_metric_keys = {
        "onset_to_playback_stop_ms",
        "onset_to_cancel_sent_ms",
        "cancel_to_provider_cancelled_ms",
        "onset_to_first_foreground_audio_ms",
        "cleared_bytes",
        "late_discarded_bytes",
        "rendered_after_fence_bytes",
        "usage",
    }
    assert set(outcome.report.metrics) == expected_metric_keys
    assert all(
        isinstance(outcome.report.metrics[key], int) and outcome.report.metrics[key] >= 0
        for key in expected_metric_keys - {"usage"}
    )
    assert outcome.report.metrics["usage"] == {
        "input_tokens": 60,
        "output_tokens": 6,
    }


@pytest.mark.asyncio
async def test_auto_cancel_baseline_waits_for_natural_terminal_before_guard() -> None:
    provider = ScriptedAutoCancelBaselineProvider()
    state = HostState(run_id="run-auto-baseline", delegate_id="delegate-auto-baseline")
    session = RealtimeProbeSession(provider=provider, state=state, pace_audio=False)
    fixture = b"\x01\x00" * 640

    outcome = await interruption.execute_auto_cancel_baseline(session, {"barge_in": fixture})

    assert outcome.report.status == "pass"
    sent_types = [event["type"] for event in provider.sent]
    cancel_index = sent_types.index("response.cancel")
    guard_create_index = sent_types.index("response.create")
    assert sent_types.count("response.cancel") == 1
    assert sent_types.count("response.create") == 1
    assert "response.create" not in sent_types[:cancel_index]
    assert cancel_index < guard_create_index
    old_terminal = next(
        event
        for event in outcome.events
        if event.kind == "provider.response_done" and event.data.get("purpose") == "target"
    )
    guard_create = next(
        event
        for event in outcome.events
        if event.kind == "host.response_create" and event.data.get("purpose") == "guard"
    )
    assert old_terminal.t_ms < guard_create.t_ms
    assert set(outcome.report.metrics) == {
        "cancel_to_rejection_ms",
        "cancel_to_old_terminal_ms",
        "guard_create_to_first_audio_ms",
        "guard_end_to_end_ms",
    }
    assert all(isinstance(value, int) and value >= 0 for value in outcome.report.metrics.values())
    assert outcome.audio["target_automatic_response"]
    assert outcome.audio["guard"]


@pytest.mark.asyncio
async def test_shared_turn_ignores_delegate_transcript_that_arrives_before_barge_in() -> None:
    provider = LateDelegateTranscriptProvider()
    state = HostState(run_id="run-late-transcript", delegate_id="delegate-late-transcript")
    session = RealtimeProbeSession(provider=provider, state=state, pace_audio=False)
    fixture = b"\x01\x00" * 640

    outcome = await execute_smart_cancel(
        session,
        {"delegate_request": fixture, "barge_in": fixture},
        sink_factory=_deterministic_sink,
    )

    barges = [
        item
        for item in outcome.events
        if item.kind == "provider.user_transcript" and item.data.get("purpose") == "barge_in"
    ]
    assert outcome.report.status == "pass"
    assert len(barges) == 1
    assert barges[0].data["text"] == "顺便问一下，七乘八是多少？"


@pytest.mark.asyncio
async def test_shared_smart_cancel_turn_uses_the_existing_connected_delegate() -> None:
    provider = ScriptedInterruptionProvider()
    state = HostState(run_id="run-shared", delegate_id="delegate-shared")
    session = RealtimeProbeSession(provider=provider, state=state, pace_audio=False)
    fixture = b"\x01\x00" * 640
    await session.connect(turn_detection={"type": "smart_turn"})
    await session.request_delegate(fixture, manual=False)
    progress_step = next(step for step in build_scenario("full") if step.step_id == "progress-1")

    result = await interruption.collect_smart_cancel_turn(
        session,
        progress_step=progress_step,
        barge_pcm=fixture,
        nonce="shared-turn",
        sink_factory=_deterministic_sink,
    )

    assert result.progress.status == "cancelled"
    assert result.foreground.transcript == "七乘八等于五十六。"
    assert result.rendered_progress_audio
    assert result.foreground_audio
    assert state.spoken_progress_ids == []
    assert state.interrupted_progress_ids == ["progress-1"]
    assert (
        len([event for event in session.events if event.kind == "host.progress_interrupted"]) == 1
    )
    assert [event["type"] for event in provider.sent].count("session.update") == 1
    assert len([event for event in session.events if event.kind == "provider.tool_call"]) == 1


@pytest.mark.asyncio
async def test_cancel_terminal_waits_for_successful_cancel_send_record() -> None:
    provider = TerminalDuringCancelSendProvider()
    state = HostState(run_id="run-cancel-race", delegate_id="delegate-cancel-race")
    session = RealtimeProbeSession(provider=provider, state=state, pace_audio=False)
    fixture = b"\x01\x00" * 640

    outcome = await asyncio.wait_for(
        execute_smart_cancel(
            session,
            {"delegate_request": fixture, "barge_in": fixture},
            sink_factory=_deterministic_sink,
        ),
        timeout=1,
    )

    assert outcome.report.status == "pass"
    assert provider.terminal_received_during_cancel_send is True
    cancel = next(event for event in outcome.events if event.kind == "host.response_cancel")
    terminal = next(
        event for event in outcome.events if event.kind == "provider.response_cancelled"
    )
    assert cancel.t_ms < terminal.t_ms
    assert terminal.provider["item_id"] == "item-progress-output"
    assert terminal.data["output_item_ids"] == ["item-progress-output"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "provider_type",
    [DeltaTerminalThenTranscriptProvider, TerminalThenTranscriptProvider],
)
async def test_foreground_waits_for_official_transcript_after_terminal(
    provider_type: type[ScriptedInterruptionProvider],
) -> None:
    provider = provider_type()
    state = HostState(run_id="run-transcript-race", delegate_id="delegate-transcript-race")
    session = RealtimeProbeSession(provider=provider, state=state, pace_audio=False)
    fixture = b"\x01\x00" * 640

    outcome = await asyncio.wait_for(
        execute_smart_cancel(
            session,
            {"delegate_request": fixture, "barge_in": fixture},
            sink_factory=_deterministic_sink,
        ),
        timeout=1,
    )

    assert outcome.report.status == "pass"
    foreground = [
        event
        for event in outcome.events
        if event.kind == "assistant.transcript" and event.data.get("purpose") == "foreground"
    ]
    assert len(foreground) == 1
    assert foreground[0].data["text"] == "七乘八等于五十六。"


@pytest.mark.asyncio
async def test_response_done_output_transcript_is_an_official_fallback() -> None:
    provider = OutputTranscriptFallbackProvider()
    state = HostState(run_id="run-output-text", delegate_id="delegate-output-text")
    session = RealtimeProbeSession(provider=provider, state=state, pace_audio=False)
    fixture = b"\x01\x00" * 640

    outcome = await execute_smart_cancel(
        session,
        {"delegate_request": fixture, "barge_in": fixture},
        sink_factory=_deterministic_sink,
    )

    assert outcome.report.status == "pass"
    foreground = next(
        event
        for event in outcome.events
        if event.kind == "assistant.transcript" and event.data.get("purpose") == "foreground"
    )
    assert foreground.data["text"] == "七乘八等于五十六。"


@pytest.mark.asyncio
async def test_output_item_event_id_survives_terminal_without_output() -> None:
    provider = OutputItemOnlyProgressProvider()
    state = HostState(run_id="run-output-item", delegate_id="delegate-output-item")
    session = RealtimeProbeSession(provider=provider, state=state, pace_audio=False)
    fixture = b"\x01\x00" * 640

    outcome = await execute_smart_cancel(
        session,
        {"delegate_request": fixture, "barge_in": fixture},
        sink_factory=_deterministic_sink,
    )

    assert outcome.report.status == "pass"
    terminal = next(
        event for event in outcome.events if event.kind == "provider.response_cancelled"
    )
    assert terminal.provider["item_id"] == "item-progress-output"
    assert terminal.data["output_item_ids"] == ["item-progress-output"]


@pytest.mark.asyncio
async def test_late_prior_response_does_not_claim_progress_route() -> None:
    provider = LateAckBeforeProgressProvider()
    state = HostState(run_id="run-late-ack", delegate_id="delegate-late-ack")
    session = RealtimeProbeSession(provider=provider, state=state, pace_audio=False)
    fixture = b"\x01\x00" * 640

    outcome = await asyncio.wait_for(
        execute_smart_cancel(
            session,
            {"delegate_request": fixture, "barge_in": fixture},
            sink_factory=_deterministic_sink,
        ),
        timeout=1,
    )

    assert outcome.report.status == "pass"
    progress_ids = {
        event.provider.get("response_id")
        for event in outcome.events
        if event.data.get("purpose") == "progress"
    }
    assert progress_ids == {"response-progress"}


@pytest.mark.asyncio
async def test_completed_progress_after_cancel_is_a_semantic_failure() -> None:
    provider = CompletedAfterCancelProvider()
    state = HostState(run_id="run-completed", delegate_id="delegate-completed")
    session = RealtimeProbeSession(provider=provider, state=state, pace_audio=False)
    fixture = b"\x01\x00" * 640

    outcome = await execute_smart_cancel(
        session,
        {"delegate_request": fixture, "barge_in": fixture},
        sink_factory=_deterministic_sink,
    )

    assert outcome.report.status == "fail"
    assert "response_not_cancelled" in outcome.report.gates[0].reason_codes
    progress_done = next(
        event
        for event in outcome.events
        if event.kind == "provider.response_done" and event.data.get("purpose") == "progress"
    )
    assert progress_done.data["status"] == "completed"
    assert progress_done.data["status_details"] == {"reason": "natural_completion"}
    assert not any(
        event.kind == "provider.response_cancelled" and event.data.get("purpose") == "progress"
        for event in outcome.events
    )
    assert outcome.report.metrics["cancel_to_provider_cancelled_ms"] == "unknown"
    assert state.delegate_status == "running"


@pytest.mark.asyncio
async def test_provider_failure_is_sanitized_and_finishes_playback() -> None:
    provider = ExplodingCancelProvider()
    state = HostState(run_id="run-failure", delegate_id="delegate-failure")
    session = RealtimeProbeSession(provider=provider, state=state, pace_audio=False)
    fixture = b"\x01\x00" * 640
    sink = TrackingSink()

    with pytest.raises(ProviderError) as raised:
        await asyncio.wait_for(
            execute_smart_cancel(
                session,
                {"delegate_request": fixture, "barge_in": fixture},
                sink_factory=lambda: sink,
            ),
            timeout=1,
        )

    message = str(raised.value)
    assert "secret-dashscope-key" not in message
    assert "payload" not in message
    assert sink.finished_called is True
    assert sink.run_exited.is_set()


@pytest.mark.asyncio
async def test_provider_timeout_is_sanitized_and_finishes_playback() -> None:
    provider = MissingCancelTerminalProvider()
    state = HostState(run_id="run-timeout", delegate_id="delegate-timeout")
    session = RealtimeProbeSession(
        provider=provider,
        state=state,
        pace_audio=False,
        timeout_s=0.01,
    )
    fixture = b"\x01\x00" * 640
    sink = TrackingSink()

    with pytest.raises(ProviderError) as raised:
        await asyncio.wait_for(
            execute_smart_cancel(
                session,
                {"delegate_request": fixture, "barge_in": fixture},
                sink_factory=lambda: sink,
            ),
            timeout=1,
        )

    assert str(raised.value) == "Qwen realtime event timeout"
    assert raised.value.reason_code == "qwen_event_timeout"
    assert sink.finished_called is True
    assert sink.run_exited.is_set()


@pytest.mark.asyncio
async def test_progress_terminal_without_audio_uses_harness_deadline() -> None:
    provider = ProgressWithoutAudioProvider()
    state = HostState(run_id="run-no-audio", delegate_id="delegate-no-audio")
    session = RealtimeProbeSession(
        provider=provider,
        state=state,
        pace_audio=False,
        timeout_s=0.01,
    )
    fixture = b"\x01\x00" * 640
    sink = TrackingSink()

    with pytest.raises(ProviderError, match="smart-cancel orchestration") as raised:
        await asyncio.wait_for(
            execute_smart_cancel(
                session,
                {"delegate_request": fixture, "barge_in": fixture},
                sink_factory=lambda: sink,
            ),
            timeout=0.2,
        )

    assert raised.value.reason_code == "smart_cancel_timeout"
    assert sink.finished_called is True
    assert sink.run_exited.is_set()


@pytest.mark.asyncio
async def test_external_cancellation_wins_over_cleanup_failure_without_run_leak() -> None:
    provider = MissingCancelTerminalProvider()
    state = HostState(run_id="run-cancelled", delegate_id="delegate-cancelled")
    session = RealtimeProbeSession(provider=provider, state=state, pace_audio=False)
    fixture = b"\x01\x00" * 640
    sink = FailingFinishSink()
    execution = asyncio.create_task(
        execute_smart_cancel(
            session,
            {"delegate_request": fixture, "barge_in": fixture},
            sink_factory=lambda: sink,
        )
    )
    await asyncio.wait_for(sink.run_started.wait(), timeout=1)
    await asyncio.sleep(0)

    execution.cancel()

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(asyncio.shield(execution), timeout=0.2)
    assert sink.finished_called is True
    assert sink.run_exited.is_set()


@pytest.mark.asyncio
async def test_full_scenario_reconnects_and_passes_all_six_gates() -> None:
    first_provider = ScriptedFullProvider()
    second_provider = ScriptedFullProvider(reconnect=True)
    state = HostState(run_id="run-full", delegate_id="delegate-full")
    session = RealtimeProbeSession(provider=first_provider, state=state)
    fixture = b"\x00\x00" * 16

    outcome = await execute_full(
        session,
        {
            "delegate_request": fixture,
            "barge_in": fixture,
            "recovery_question": fixture,
            "context_followup": fixture,
        },
        api_key="unused-test-key",
        reconnect_provider_factory=lambda: second_provider,
    )

    assert outcome.report.status == "pass"
    assert [gate.status for gate in outcome.report.gates] == ["pass"] * 6
    assert first_provider.closed is True
    assert second_provider.closed is True
    assert state.delegate_status == "completed"
    assert state.spoken_progress_ids == ["progress-1", "progress-2", "progress-3"]
    assert len([event for event in outcome.events if event.kind == "host.recovery_snapshot"]) == 1
    assert len([event for event in outcome.events if event.kind == "host.final_spoken"]) == 1


@pytest.mark.asyncio
async def test_integrated_full_uses_smart_cancel_and_keeps_interrupted_progress_unspoken() -> None:
    first_provider = ScriptedFullProvider()
    second_provider = ScriptedFullProvider(reconnect=True)
    state = HostState(run_id="run-integrated", delegate_id="delegate-integrated")
    session = RealtimeProbeSession(provider=first_provider, state=state)
    fixture = b"\x00\x00" * 640

    outcome = await execute_full(
        session,
        {
            "delegate_request": fixture,
            "barge_in": fixture,
            "recovery_question": fixture,
            "context_followup": fixture,
        },
        api_key="unused-test-key",
        reconnect_provider_factory=lambda: second_provider,
        smart_cancel=True,
    )

    assert outcome.report.status == "pass", [
        (gate.gate, gate.status, gate.reason_codes) for gate in outcome.report.gates
    ]
    assert [gate.status for gate in outcome.report.gates] == ["pass"] * 6
    assert state.spoken_progress_ids == ["progress-2", "progress-3"]
    assert state.interrupted_progress_ids == ["progress-1"]
    assert (
        len([event for event in outcome.events if event.kind == "host.progress_interrupted"]) == 1
    )
    assert not any(
        event.kind == "host.progress_spoken" and event.data.get("progress_id") == "progress-1"
        for event in outcome.events
    )


@pytest.mark.asyncio
async def test_full_scenario_closes_the_reconnected_provider_on_failure() -> None:
    first_provider = ScriptedFullProvider()
    second_provider = FailingRecoveredProvider()
    state = HostState(run_id="run-full", delegate_id="delegate-full")
    session = RealtimeProbeSession(provider=first_provider, state=state)
    fixture = b"\x00\x00" * 16

    with pytest.raises(ProviderError, match="synthetic recovered-session failure"):
        await execute_full(
            session,
            {
                "delegate_request": fixture,
                "barge_in": fixture,
                "recovery_question": fixture,
                "context_followup": fixture,
            },
            api_key="unused-test-key",
            reconnect_provider_factory=lambda: second_provider,
        )

    assert first_provider.closed is True
    assert second_provider.closed is True


@pytest.mark.asyncio
async def test_full_live_preserves_semantic_failure_when_recovered_close_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: object
) -> None:
    fixture_dir = tmp_path / "fixtures"
    fixture_dir.mkdir()
    for name in FIXTURE_TEXT:
        (fixture_dir / f"{name}.pcm").write_bytes(b"\x01\x00" * 640)
    all_providers = [
        provider
        for _ in range(3)
        for provider in (
            ScriptedFullProvider(),
            SemanticFailingCloseRecoveredProvider(),
        )
    ]
    providers = list(all_providers)
    monkeypatch.setattr(live, "QwenRealtimeProvider", lambda api_key: providers.pop(0))

    exit_code = await live._run_live(
        SimpleNamespace(
            phase="full",
            arm=None,
            runs=1,
            fixture_dir=fixture_dir,
            output=tmp_path / "output",
        ),
        "unused-test-key",
        pace_audio=False,
    )

    root = next((tmp_path / "output").glob("*-qwen-full"))
    summary = json.loads((root / "summary.json").read_text())
    report = json.loads((root / "attempt-01" / "report.json").read_text())
    persisted = "\n".join(path.read_text(errors="ignore") for path in root.rglob("*.*"))
    captured = capsys.readouterr()  # type: ignore[attr-defined]

    assert exit_code == 1
    assert summary["decision"] == "failed"
    assert summary["attempts"] == 1
    assert not (root / "attempt-02").exists()
    assert report["gates"][5]["reason_codes"] == ["post_recovery_context_wrong"]
    assert "secret-key" not in persisted
    assert "payload" not in persisted
    assert "secret-key" not in captured.out
    assert "payload" not in captured.err
    assert all(provider.closed for provider in all_providers[:2])


@pytest.mark.asyncio
async def test_integrated_full_live_routes_and_persists_registered_experiment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture_dir = tmp_path / "fixtures"
    fixture_dir.mkdir()
    for name in FIXTURE_TEXT:
        (fixture_dir / f"{name}.pcm").write_bytes(b"\x01\x00" * 640)
    providers = [ScriptedFullProvider(), ScriptedFullProvider(reconnect=True)]
    monkeypatch.setattr(live, "QwenRealtimeProvider", lambda api_key: providers.pop(0))

    exit_code = await live._run_live(
        SimpleNamespace(
            phase="full",
            arm="smart-cancel",
            runs=1,
            fixture_dir=fixture_dir,
            output=tmp_path / "output",
        ),
        "unused-test-key",
        pace_audio=False,
    )

    root = next((tmp_path / "output").glob("*-qwen-full-smart-cancel"))
    attempt = root / "attempt-01"
    summary = json.loads((root / "summary.json").read_text())
    manifest = json.loads((attempt / "manifest.json").read_text())
    trajectory = (attempt / "trajectory.jsonl").read_text()

    assert exit_code == 0
    assert summary["decision"] == "succeeded"
    assert summary["attempts"] == 1
    assert summary["experiment_id"] == "qwen-full-smart-cancel.v1"
    assert manifest["experiment_id"] == "qwen-full-smart-cancel.v1"
    assert '"kind": "host.progress_interrupted"' in trajectory
    assert (attempt / "output" / "progress_1_interrupted.wav").exists()
    assert (attempt / "output" / "foreground_barge_in.wav").exists()


@pytest.mark.asyncio
async def test_interruption_live_routes_and_persists_private_artifacts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture_dir = tmp_path / "fixtures"
    fixture_dir.mkdir()
    for name in FIXTURE_TEXT:
        (fixture_dir / f"{name}.pcm").write_bytes(b"\x01\x00" * 640)
    provider = ScriptedInterruptionProvider()
    monkeypatch.setattr(live, "QwenRealtimeProvider", lambda api_key: provider)

    exit_code = await live._run_live(
        SimpleNamespace(
            phase="interruption",
            arm="smart-cancel",
            runs=1,
            fixture_dir=fixture_dir,
            output=tmp_path / "output",
        ),
        "unused-test-key",
        pace_audio=False,
    )

    root = next((tmp_path / "output").glob("*-qwen-interruption-smart-cancel"))
    attempt = root / "attempt-01"
    summary = json.loads((root / "summary.json").read_text())

    assert exit_code == 0
    assert summary["decision"] == "succeeded"
    assert summary["attempts"] == 1
    assert summary["arm"] == "smart-cancel"
    assert (attempt / "output" / "progress_rendered.wav").exists()
    assert (attempt / "output" / "foreground.wav").exists()
    assert (attempt / "input" / "barge_in.pcm").exists()
    assert json.loads((attempt / "manifest.json").read_text())["arm"] == "smart-cancel"
    for name in ("progress_rendered", "foreground"):
        with wave.open(str(attempt / "output" / f"{name}.wav"), "rb") as wav_file:
            assert wav_file.getframerate() == 24_000


@pytest.mark.asyncio
async def test_interruption_live_stops_after_its_first_semantic_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture_dir = tmp_path / "fixtures"
    fixture_dir.mkdir()
    for name in FIXTURE_TEXT:
        (fixture_dir / f"{name}.pcm").write_bytes(b"\x01\x00" * 640)
    provider = CompletedAfterCancelProvider()
    monkeypatch.setattr(live, "QwenRealtimeProvider", lambda api_key: provider)

    exit_code = await live._run_live(
        SimpleNamespace(
            phase="interruption",
            arm="smart-cancel",
            runs=1,
            fixture_dir=fixture_dir,
            output=tmp_path / "output",
        ),
        "unused-test-key",
        pace_audio=False,
    )

    root = next((tmp_path / "output").glob("*-qwen-interruption-smart-cancel"))
    summary = json.loads((root / "summary.json").read_text())

    assert exit_code == 1
    assert summary["decision"] == "failed"
    assert summary["attempts"] == 1
    assert (root / "attempt-01").exists()
    assert not (root / "attempt-02").exists()


@pytest.mark.asyncio
async def test_interruption_live_replaces_harness_invalid_with_one_valid_attempt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture_dir = tmp_path / "fixtures"
    fixture_dir.mkdir()
    for name in FIXTURE_TEXT:
        (fixture_dir / f"{name}.pcm").write_bytes(b"\x01\x00" * 640)
    providers = [FailingConnectProvider(), ScriptedInterruptionProvider()]
    monkeypatch.setattr(live, "QwenRealtimeProvider", lambda api_key: providers.pop(0))

    exit_code = await live._run_live(
        SimpleNamespace(
            phase="interruption",
            arm="smart-cancel",
            runs=1,
            fixture_dir=fixture_dir,
            output=tmp_path / "output",
        ),
        "unused-test-key",
        pace_audio=False,
    )

    root = next((tmp_path / "output").glob("*-qwen-interruption-smart-cancel"))
    summary = json.loads((root / "summary.json").read_text())
    persisted = "\n".join(
        path.read_text(errors="ignore") for path in (root / "attempt-01").rglob("*.*")
    )

    assert exit_code == 0
    assert summary["decision"] == "succeeded"
    assert summary["attempts"] == 2
    assert json.loads((root / "attempt-01" / "manifest.json").read_text())["errors"] == [
        "ProviderError"
    ]
    assert "secret-key" not in persisted
    assert "payload" not in persisted
    assert "unused-test-key" not in persisted
    assert (root / "attempt-02").exists()


@pytest.mark.asyncio
async def test_interruption_live_requires_one_run(tmp_path: Path) -> None:
    exit_code = await live._run_live(
        SimpleNamespace(
            phase="interruption",
            arm="smart-cancel",
            runs=2,
            fixture_dir=tmp_path / "missing-fixtures",
            output=tmp_path / "output",
        ),
        "unused-test-key",
    )

    assert exit_code == 2


@pytest.mark.asyncio
async def test_interruption_live_uses_distinct_roots_when_started_in_the_same_second(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture_dir = tmp_path / "fixtures"
    fixture_dir.mkdir()
    for name in FIXTURE_TEXT:
        (fixture_dir / f"{name}.pcm").write_bytes(b"\x01\x00" * 640)
    providers = [ScriptedInterruptionProvider(), ScriptedInterruptionProvider()]

    class FixedDatetime:
        @classmethod
        def now(cls, tz: object = None) -> datetime:
            return datetime(2026, 8, 2, 12, 0, 0)

    monkeypatch.setattr(live, "datetime", FixedDatetime)
    monkeypatch.setattr(live, "QwenRealtimeProvider", lambda api_key: providers.pop(0))
    args = SimpleNamespace(
        phase="interruption",
        arm="smart-cancel",
        runs=1,
        fixture_dir=fixture_dir,
        output=tmp_path / "output",
    )

    assert await live._run_live(args, "unused-test-key", pace_audio=False) == 0
    assert await live._run_live(args, "unused-test-key", pace_audio=False) == 0

    roots = sorted((tmp_path / "output").glob("*-qwen-interruption-smart-cancel"))
    assert len(roots) == 2
    for root in roots:
        assert (root / "attempt-01").is_dir()
        assert (root / "summary.json").is_file()


@pytest.mark.asyncio
async def test_interruption_live_sanitizes_runtime_connect_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: object
) -> None:
    fixture_dir = tmp_path / "fixtures"
    fixture_dir.mkdir()
    for name in FIXTURE_TEXT:
        (fixture_dir / f"{name}.pcm").write_bytes(b"\x01\x00" * 640)
    monkeypatch.setattr(
        live,
        "QwenRealtimeProvider",
        lambda api_key: RuntimeFailingConnectProvider(),
    )

    exit_code = await live._run_live(
        SimpleNamespace(
            phase="interruption",
            arm="smart-cancel",
            runs=1,
            fixture_dir=fixture_dir,
            output=tmp_path / "output",
        ),
        "unused-test-key",
        pace_audio=False,
    )

    root = next((tmp_path / "output").glob("*-qwen-interruption-smart-cancel"))
    persisted = "\n".join(path.read_text(errors="ignore") for path in root.rglob("*.*"))
    captured = capsys.readouterr()  # type: ignore[attr-defined]

    assert exit_code == 2
    assert json.loads((root / "attempt-01" / "manifest.json").read_text())["errors"] == [
        "smart_cancel_orchestration_failed"
    ]
    assert "secret-key" not in persisted
    assert "payload" not in persisted
    assert "secret-key" not in captured.out
    assert "payload" not in captured.err


@pytest.mark.asyncio
async def test_interruption_live_persists_safe_provider_reason_code(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture_dir = tmp_path / "fixtures"
    fixture_dir.mkdir()
    for name in FIXTURE_TEXT:
        (fixture_dir / f"{name}.pcm").write_bytes(b"\x01\x00" * 640)
    monkeypatch.setattr(
        live,
        "QwenRealtimeProvider",
        lambda api_key: ReasonCodedFailingConnectProvider(),
    )

    exit_code = await live._run_live(
        SimpleNamespace(
            phase="interruption",
            arm="smart-cancel",
            runs=1,
            fixture_dir=fixture_dir,
            output=tmp_path / "output",
        ),
        "unused-test-key",
        pace_audio=False,
    )

    root = next((tmp_path / "output").glob("*-qwen-interruption-smart-cancel"))
    errors = [
        json.loads((root / f"attempt-{attempt:02d}" / "manifest.json").read_text())["errors"]
        for attempt in range(1, 4)
    ]

    assert exit_code == 2
    assert errors == [["qwen_connection_failed"]] * 3


@pytest.mark.asyncio
async def test_interruption_live_sanitizes_unwrapped_runtime_execution_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: object
) -> None:
    fixture_dir = tmp_path / "fixtures"
    fixture_dir.mkdir()
    for name in FIXTURE_TEXT:
        (fixture_dir / f"{name}.pcm").write_bytes(b"\x01\x00" * 640)

    async def fail_execution(*args: object, **kwargs: object) -> object:
        raise RuntimeError("execution secret-key payload")

    monkeypatch.setattr(
        live, "QwenRealtimeProvider", lambda api_key: ScriptedInterruptionProvider()
    )
    monkeypatch.setattr(live, "execute_smart_cancel", fail_execution)

    exit_code = await live._run_live(
        SimpleNamespace(
            phase="interruption",
            arm="smart-cancel",
            runs=1,
            fixture_dir=fixture_dir,
            output=tmp_path / "output",
        ),
        "unused-test-key",
        pace_audio=False,
    )

    root = next((tmp_path / "output").glob("*-qwen-interruption-smart-cancel"))
    persisted = "\n".join(path.read_text(errors="ignore") for path in root.rglob("*.*"))
    captured = capsys.readouterr()  # type: ignore[attr-defined]

    assert exit_code == 2
    assert json.loads((root / "attempt-01" / "manifest.json").read_text())["errors"] == [
        "RuntimeError"
    ]
    assert "secret-key" not in persisted
    assert "payload" not in persisted
    assert "secret-key" not in captured.out
    assert "payload" not in captured.err


@pytest.mark.asyncio
async def test_interruption_live_preserves_semantic_failure_when_close_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: object
) -> None:
    fixture_dir = tmp_path / "fixtures"
    fixture_dir.mkdir()
    for name in FIXTURE_TEXT:
        (fixture_dir / f"{name}.pcm").write_bytes(b"\x01\x00" * 640)
    monkeypatch.setattr(
        live,
        "QwenRealtimeProvider",
        lambda api_key: RuntimeFailingSemanticCloseProvider(),
    )

    exit_code = await live._run_live(
        SimpleNamespace(
            phase="interruption",
            arm="smart-cancel",
            runs=1,
            fixture_dir=fixture_dir,
            output=tmp_path / "output",
        ),
        "unused-test-key",
        pace_audio=False,
    )

    root = next((tmp_path / "output").glob("*-qwen-interruption-smart-cancel"))
    persisted = "\n".join(path.read_text(errors="ignore") for path in root.rglob("*.*"))
    captured = capsys.readouterr()  # type: ignore[attr-defined]

    summary = json.loads((root / "summary.json").read_text())

    assert exit_code == 1
    assert summary["decision"] == "failed"
    assert summary["attempts"] == 1
    assert not (root / "attempt-02").exists()
    assert "secret-key" not in persisted
    assert "payload" not in persisted
    assert "secret-key" not in captured.out
    assert "payload" not in captured.err
