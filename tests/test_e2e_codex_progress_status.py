"""Deterministic CI backend for ``qwen-codex-live-progress-status.v1``.

The scenario runs against production components with only the two external
nondeterminism sources replaced: a scripted App Server peer instead of the Codex
binary, and a scripted realtime provider instead of Qwen. Everything between them is
real — ``AppServerTurnProjection`` composes the summary, ``CodexLiveAdapter`` and
``Runtime`` carry it into Memory, and ``RealtimeService``/``RealtimeSession`` decide
when a host fact may take the floor.

Two things are worth naming because they are easy to misread:

* Every delivered assistant transcript is recorded under the one ``status.transcript``
  kind, and the evaluator bands them by position (acknowledgement before the first
  progress fact, the status answer after the question, the final view after the final
  fact). The recorder therefore never has to guess which response it is watching.
* The scripted peer's first completed item is a ``commandExecution``. Under the R125
  cadence it projects nothing at all. The scripted Surrogate also declines the first
  low-value prose summary and selects the later informative implementation milestone;
  only that selected fact opens the status-question window.
"""

from __future__ import annotations

import asyncio
import itertools
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from nova_audio_agent.clock import RealClock, VirtualClock
from nova_audio_agent.context_view import ContextView
from nova_audio_agent.evals.codex_progress_status import (
    CODEX_RUN_TOOL_NAME,
    GATE_PROJECTION,
    STATUS_QUESTION,
    WORK_ORDER,
    ScenarioRecorder,
    build_report_mapping,
    evaluate_codex_progress_status,
    failure_reason,
    is_informative,
)
from nova_audio_agent.evals.event_report_fixture import (
    EXPECTED_FIXTURE_TESTS,
    FixtureTestRun,
    changed_paths,
    copy_event_report_fixture,
    run_fixture_tests,
    verify_workspace,
    workspace_hashes,
)
from nova_audio_agent.events import HandoffEvent, ProgressEvent
from nova_audio_agent.executors.codex_app_server import CodexAppServerTransport
from nova_audio_agent.executors.codex_live import CODEX_LIVE_MANIFEST, CodexLiveAdapter
from nova_audio_agent.memory import CONVERSATION_CHANNEL, USER_PRIORITY, Memory
from nova_audio_agent.ports import SurrogateOutput
from nova_audio_agent.realtime.bridge import RealtimeRuntimeBridge
from nova_audio_agent.realtime.playback import PlaybackCompletion, PlaybackRegistry
from nova_audio_agent.realtime.protocol import (
    HostContextItem,
    HostResponseIntent,
    ItemIdentity,
    ResponseAudioDelta,
    ResponseStarted,
    ResponseTerminal,
    ResponseTranscriptFinal,
    SessionIdentity,
    ToolCallReady,
    UserSpeechEnded,
    UserSpeechStarted,
    UserTranscriptFinal,
)
from nova_audio_agent.realtime.service import RealtimeService
from nova_audio_agent.realtime.session import RealtimeSession
from nova_audio_agent.realtime.speech_prep import SPEECH_FINAL_LIMIT, prepare_for_speech
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.tool_schema import compile_tool_schema
from scripts import eval_codex_progress_status as live_progress
from test_codex_app_server import _Factory, _Peer, _Preflight, _ProtocolProbe
from test_tetris_artifact import _game as write_reference_tetris

SENTINEL_COMMAND = "SENTINEL-RAW-COMMAND-ZERO"
SENTINEL_OUTPUT = "SENTINEL-COMMAND-OUTPUT-ONE"
SENTINEL_REASONING = "SENTINEL-RAW-REASONING-TWO"
SENTINEL_SECRET = "".join(("s", "k-sentinel-progress-credential-3"))

ACK_TRANSCRIPT = "行，我把这个任务交给 Codex，它开始跑了我再跟你说。"
PROGRESS_TRANSCRIPT = "Codex 那边有进展，我先接着看。"
STATUS_ANSWER = "它正在实现 event_report 的 parser 解析，已经开始执行命令，还没完成。"
FINAL_TEXT = "已实现 parser、aggregate 和 render，全部 17 个测试通过。"
FINAL_TRANSCRIPT = "Codex 说三个模块都实现好了，测试全部通过。"


def _turn_items(workspace: Path) -> tuple[dict[str, Any], ...]:
    """Pinned 0.145.0 ThreadItem shapes with sentinels in every raw field.

    The projection's closed allowlist reads ``text`` from ``agentMessage``/``plan`` and
    counts the typed categories; nothing else may travel. Command strings, aggregated
    output, reasoning, absolute paths, and the credential are all present here so their
    absence downstream is evidence rather than luck.
    """
    return (
        {
            "type": "commandExecution",
            "command": f"{SENTINEL_COMMAND} --cwd {workspace}",
            "aggregatedOutput": SENTINEL_OUTPUT,
            "cwd": str(workspace),
            "exitCode": 0,
        },
        {
            "type": "fileChange",
            "changes": [{"path": f"{workspace}/event_report/parser.py", "kind": "modify"}],
        },
        {
            "type": "plan",
            "text": "先读一遍 event_report 的三个模块",
            "reasoning": SENTINEL_REASONING,
        },
        {"type": "reasoning", "text": SENTINEL_REASONING},
        {
            "type": "agentMessage",
            "text": (
                f"正在实现 event_report 的 parser JSONL 解析和 aggregate 去重"
                f"（工作区 {workspace}，凭据 {SENTINEL_SECRET}），然后运行 unittest 验证"
            ),
        },
    )


class ScriptedProvider:
    """A realtime provider with no socket: the driver decides every provider event.

    Same seam as ``tests/test_realtime_service.py::FakeProvider``. ``inject_host_item``
    is the scenario's progress/final fact recorder, because that call is the exact
    moment a host fact enters the provider conversation.
    """

    def __init__(self, recorder: ScenarioRecorder) -> None:
        self._recorder = recorder
        self.epoch = 0
        self.injected: list[HostContextItem] = []
        self.response_intents: list[HostResponseIntent] = []
        self.audio_sent = 0

    async def connect(self, *, tools: tuple[dict[str, object], ...]) -> SessionIdentity:
        del tools
        self.epoch += 1
        return SessionIdentity(self.epoch, f"session-{self.epoch}")

    async def send_audio(self, pcm: bytes) -> None:
        self.audio_sent += len(pcm)

    async def inject_host_item(self, item: HostContextItem) -> ItemIdentity:
        self.injected.append(item)
        if item.kind == "progress":
            self._recorder.record(
                "progress.fact", {"event_id": item.event_id, "content": item.content}
            )
        elif item.kind == "final":
            self._recorder.record(
                "final.fact", {"event_id": item.event_id, "content": item.content}
            )
        return ItemIdentity(self.epoch, item.host_item_id, f"provider-{item.host_item_id}")

    async def create_response(self, intent: HostResponseIntent) -> None:
        self.response_intents.append(intent)

    async def cancel_response(self, response_id: str) -> None:
        del response_id

    async def close(self) -> None:
        return None

    async def events(self):  # noqa: ANN201 - protocol shape is an async iterator
        if False:  # pragma: no cover - the driver pushes events directly
            yield ResponseStarted(session_epoch=1, response_id="unused")


class ScriptedPeer(_Peer):
    """``_Peer`` with manual item feeding so the clock can advance between items."""

    def __init__(self, workspace: Path) -> None:
        super().__init__(
            workspace,
            hold_completion=True,
            turn_items=(),
            final_text=FINAL_TEXT,
        )

    def emit_item(self, item: dict[str, Any]) -> None:
        self._feed(
            {
                "method": "item/completed",
                "params": {
                    "threadId": "thread-private",
                    "turnId": "turn-private",
                    "item": item,
                },
            }
        )


class ScriptedSurrogate:
    """Decline planning chatter and select only the implementation milestone."""

    def __init__(self) -> None:
        self.calls = 0

    async def watch(self, view: ContextView) -> SurrogateOutput:
        self.calls += 1
        suggestions = tuple(item for item in view.affordances if item.source == "suggestion")
        selected = next(
            (
                item
                for item in suggestions
                if "正在实现 event_report 的 parser JSONL 解析"
                in str(item.content.get("suggestion", {}).get("summary", ""))
            ),
            None,
        )
        if selected is None:
            return SurrogateOutput(speak=False, reason="规划信息暂不播报")
        return SurrogateOutput(
            speak=True,
            suggestion_id=selected.ref,
            reason="实现里程碑值得现在播报",
        )


class RecordingBridge:
    """Pass every call to the real bridge and record only the acceptance verdict.

    The delegate id is published here rather than after ``handle_event`` returns: the
    service already reports ``codex_state == "running"`` inside that same call, so a
    later assignment would miss the ``delegate.running`` observation entirely.
    """

    def __init__(
        self,
        inner: RealtimeRuntimeBridge,
        recorder: ScenarioRecorder,
        scenario: Scenario,
    ) -> None:
        self._inner = inner
        self._recorder = recorder
        self._scenario = scenario

    async def accept_user_transcript(self, text: str):  # noqa: ANN201 - delegating shim
        return await self._inner.accept_user_transcript(text)

    async def accept_tool_call(
        self,
        event: ToolCallReady,
        *,
        origin_ref: str | None = None,
    ):  # noqa: ANN201 - delegating shim
        acceptance = await self._inner.accept_tool_call(event, origin_ref=origin_ref)
        if acceptance.accepted and acceptance.delegate_id:
            self._scenario.delegate_id = acceptance.delegate_id
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


async def _settle(turns: int = 40) -> None:
    for _ in range(turns):
        await asyncio.sleep(0)


class Scenario:
    """Drive the doc's sequence over real components and record the allowlist."""

    def __init__(self, workspace: Path) -> None:
        self.workspace = workspace
        self.recorder = ScenarioRecorder(clock=RealClock())
        self.transport_clock = VirtualClock()
        self.peer = ScriptedPeer(workspace)
        self.factory = _Factory(self.peer)
        self.transport = CodexAppServerTransport(
            binary="codex-cli",
            workspace=workspace,
            api_key=SENTINEL_SECRET,
            preflight=_Preflight(),
            process_factory=self.factory,
            environ={"PATH": "/bin", "SECRET": "drop"},
            clock=self.transport_clock,
            protocol_probe=_ProtocolProbe(),
        )
        memory = Memory(policies=(CODEX_LIVE_MANIFEST.policy,))
        self.surrogate = ScriptedSurrogate()
        self.runtime = Runtime(
            clock=RealClock(),
            memory=memory,
            surrogate=self.surrogate,
            executors={"codex": CodexLiveAdapter(self.transport)},
            on_suggestion_selected=lambda suggestion, reason: self.service.on_suggestion_selected(
                suggestion, reason
            ),
        )
        memory.append(
            CONVERSATION_CHANNEL,
            ts=self.runtime.clock.now(),
            trust="trusted_user",
            priority=USER_PRIORITY,
            content={"text": WORK_ORDER},
        )
        tools = compile_tool_schema((CODEX_LIVE_MANIFEST,))
        counter = itertools.count(1)
        self.provider = ScriptedProvider(self.recorder)
        self.playback_frames: list[Any] = []
        playback = PlaybackRegistry(
            id_factory=lambda: f"playback-{next(counter)}",
            on_frame=self.playback_frames.append,
            on_clear=lambda utterance_id, epoch: None,
        )
        self.session = RealtimeSession(
            provider=self.provider,
            playback=playback,
            id_factory=lambda: f"host-{next(counter)}",
            on_delivery=self._on_delivery,
            clock=self.runtime.clock,
        )
        self.delegate_id: str | None = None
        self.bridge = RecordingBridge(
            RealtimeRuntimeBridge(
                runtime=self.runtime,
                tools=tools,
                id_factory=lambda: f"bridge-{next(counter)}",
            ),
            self.recorder,
            self,
        )
        self.service = RealtimeService(
            provider=self.provider,
            runtime=self.runtime,
            tools=tools,
            session=self.session,
            bridge=self.bridge,  # type: ignore[arg-type]
            id_factory=lambda: f"service-{next(counter)}",
            on_codex_state=self._on_codex_state,
        )
        self._seen_running = False
        self._memory_seen = 0
        self._response_ids = itertools.count(1)

    # ---- observation -------------------------------------------------------

    def _on_delivery(self, completion: Any) -> None:
        self.recorder.record(
            "status.transcript",
            {"response_id": completion.response_id, "text": completion.text},
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
        elif isinstance(event, HandoffEvent) and event.channel == "codex":
            self.recorder.record(
                "codex.handoff",
                {"delegate_id": event.delegate_id, "outcome": event.outcome},
            )

    def record_memory_progress(self) -> None:
        """Read back what Runtime Memory actually stored, not what the adapter sent."""
        channel = self.runtime.memory.channels.get("codex")
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

    # ---- provider driving --------------------------------------------------

    async def begin_response(self, response_id: str, *, pcm: bytes = b"\x00\x01") -> None:
        await self.service.handle_event(ResponseStarted(session_epoch=1, response_id=response_id))
        await self.service.handle_event(
            ResponseAudioDelta(session_epoch=1, response_id=response_id, pcm=pcm)
        )
        self.recorder.record("audio.delta", {"response_id": response_id, "bytes": len(pcm)})

    async def finish_response(self, response_id: str, text: str) -> None:
        await self.service.handle_event(
            ResponseTranscriptFinal(session_epoch=1, response_id=response_id, text=text)
        )
        await self.service.handle_event(
            ResponseTerminal(
                session_epoch=1,
                response_id=response_id,
                status="completed",
                reason="completed",
            )
        )
        generation = self.session.current_generation
        assert generation is not None
        assert self.service.playback_started(
            generation.utterance_id,
            generation.generation_epoch,
        )
        assert self.service.playback_done(generation.utterance_id, generation.generation_epoch)
        await _settle(4)

    async def speak(self, response_id: str, text: str) -> None:
        await self.begin_response(response_id)
        await self.finish_response(response_id, text)

    async def deliver_queued_facts(self, transcript: str) -> list[HostResponseIntent]:
        """Flush host items and speak each response the service creates."""
        delivered: list[HostResponseIntent] = []
        while True:
            before = len(self.provider.response_intents)
            await self.service.flush_host_items()
            await _settle(4)
            if len(self.provider.response_intents) == before:
                return delivered
            intent = self.provider.response_intents[-1]
            delivered.append(intent)
            response_id = f"response-{next(self._response_ids)}"
            await self.speak(response_id, transcript)
            if intent.item.kind == "progress":
                self.recorder.record(
                    "progress.response.terminal",
                    {"response_id": response_id, "status": "completed"},
                )

    def latest_summary(self) -> str:
        summaries = [
            str(record["data"]["summary"])
            for record in self.recorder.records
            if record["kind"] == "codex.progress" and "summary" in record["data"]
        ]
        return summaries[-1] if summaries else ""

    async def emit_items_until_informative(self) -> None:
        """Emit the first count-only item, then feed the remaining private worker items.

        R125: the first ``commandExecution`` projects nothing — no summary record and
        no spoken counts-only fact. The first worker prose is stored but the scripted
        Surrogate declines it; the 31-second keepalive carries the later implementation
        milestone, which the Surrogate selects once.
        """
        items = _turn_items(self.workspace)
        self.peer.emit_item(items[0])
        await _settle()
        self.record_memory_progress()
        delivered = await self.deliver_queued_facts(PROGRESS_TRANSCRIPT)
        assert self.latest_summary() == ""
        assert not [
            intent
            for intent in delivered
            if intent.item.kind == "progress" and "已执行" in intent.item.content
        ]

        for item in items[1:]:
            self.peer.emit_item(item)
            await _settle()

        self.transport_clock.advance_to(self.transport_clock.now() + 31.0)
        self.peer.emit_item({"type": "todoList", "text": "ignored"})
        await _settle()
        self.record_memory_progress()
        await self.deliver_queued_facts(PROGRESS_TRANSCRIPT)
        assert is_informative(self.latest_summary()), self.latest_summary()


@pytest.fixture()
def workspace(tmp_path: Path) -> Path:
    return copy_event_report_fixture(tmp_path / "event_report_task")


async def run_scenario(workspace: Path) -> Scenario:
    scenario = Scenario(workspace)
    stop = asyncio.Event()
    serving = asyncio.create_task(scenario.runtime.serve(stop))
    try:
        scenario.runtime.observe(scenario._observe)
        await scenario.service.connect()

        # 1. the user sends the fixed work order. The provider's user lifecycle
        # starts before its final transcript arrives, matching the live ordering.
        scenario.recorder.record("user.turn", {"text": WORK_ORDER})
        await scenario.service.handle_event(
            UserSpeechStarted(
                session_epoch=1,
                speech_id="speech-1",
                provider_item_id="user-1",
            )
        )
        await scenario.service.handle_event(
            UserSpeechEnded(
                session_epoch=1,
                speech_id="speech-1",
                provider_item_id="user-1",
            )
        )

        # 2-3. Qwen speaks the acknowledgement in the same response that owns
        # the accepted codex__run call.
        await scenario.begin_response("response-origin")
        scenario.recorder.record(
            "tool.call",
            {"call_id": "call-1", "name": CODEX_RUN_TOOL_NAME, "work_order": WORK_ORDER},
        )
        await scenario.service.handle_event(
            ToolCallReady(
                session_epoch=1,
                call_id="call-1",
                item_id="item-1",
                name=CODEX_RUN_TOOL_NAME,
                arguments={"work_order": WORK_ORDER, "origin_ref": "conversation:1"},
                response_id="response-origin",
            )
        )
        assert not [
            record for record in scenario.recorder.records if record["kind"] == "tool.accepted"
        ]
        await scenario.service.handle_event(
            ResponseTranscriptFinal(
                session_epoch=1,
                response_id="response-origin",
                text=ACK_TRANSCRIPT,
            )
        )
        await scenario.service.handle_event(
            ResponseTerminal(
                session_epoch=1,
                response_id="response-origin",
                status="completed",
                reason="completed",
            )
        )
        await scenario.service.handle_event(
            UserTranscriptFinal(session_epoch=1, item_id="user-1", text=WORK_ORDER)
        )
        accepted = next(
            record for record in scenario.recorder.records if record["kind"] == "tool.accepted"
        )
        assert accepted["data"]["state"] == "accepted"
        scenario.delegate_id = accepted["data"]["delegate_id"]
        generation = scenario.session.current_generation
        assert generation is not None
        assert scenario.service.playback_started(
            generation.utterance_id,
            generation.generation_epoch,
        )
        assert scenario.service.playback_done(
            generation.utterance_id,
            generation.generation_epoch,
        )
        await _settle(4)

        # 4. the App Server emits completed items; the projection composes summaries.
        await scenario.peer.turn_started.wait()
        await _settle()
        await scenario.emit_items_until_informative()

        # The progress response completed before the mandatory tool continuation.
        # Its speech must not erase the origin acknowledgement. Even if Qwen emits
        # duplicate PCM, the host keeps the continuation protocol-only.
        await scenario.service._drive_continuations()
        acknowledgement = scenario.service._semantic_acknowledgements[
            f"background:{scenario.delegate_id}"
        ]
        assert acknowledgement.origin_delivered is True
        continuation = scenario.provider.response_intents[-1]
        assert continuation.kind == "delegation_acknowledgement"
        assert continuation.origin_spoken is True
        frame_count = len(scenario.playback_frames)
        await scenario.service.handle_event(
            ResponseStarted(session_epoch=1, response_id="response-continuation")
        )
        await scenario.service.handle_event(
            ResponseAudioDelta(
                session_epoch=1,
                response_id="response-continuation",
                pcm=b"\x02\x03",
            )
        )
        await scenario.service.handle_event(
            ResponseTranscriptFinal(
                session_epoch=1,
                response_id="response-continuation",
                text="好的，任务已经安排好了，正在进行中。",
            )
        )
        response_count = len(scenario.provider.response_intents)
        await scenario.service.handle_event(
            ResponseTerminal(
                session_epoch=1,
                response_id="response-continuation",
                status="completed",
                reason="completed",
            )
        )
        assert len(scenario.playback_frames) == frame_count
        assert not any(
            record["kind"] == "status.transcript"
            and record["data"].get("response_id") == "response-continuation"
            for record in scenario.recorder.records
        )
        if len(scenario.provider.response_intents) > response_count:
            released = scenario.provider.response_intents[-1]
            assert released.kind == "host_fact"
            assert released.item.kind == "progress"
            await scenario.speak("response-released-progress", PROGRESS_TRANSCRIPT)
            scenario.recorder.record(
                "progress.response.terminal",
                {"response_id": "response-released-progress", "status": "completed"},
            )
        await scenario.deliver_queued_facts(PROGRESS_TRANSCRIPT)

        # 5-6. only now — the informative fact is injected and its response is
        # terminal, the delegate is running, and no Handoff exists yet.
        assert scenario.service.codex_state == "running"
        scenario.recorder.record("status.question", {"text": STATUS_QUESTION})
        await scenario.service.handle_event(
            UserTranscriptFinal(session_epoch=1, item_id="user-2", text=STATUS_QUESTION)
        )

        # 7. the status response is active while the Handoff arrives.
        await scenario.begin_response("response-status")
        scenario.peer.complete()
        await _settle()
        await scenario.service.flush_host_items()
        assert not [item for item in scenario.provider.injected if item.kind == "final"], (
            "the final host fact must not enter the active status response"
        )
        await scenario.finish_response("response-status", STATUS_ANSWER)

        # 8. after the status response releases the floor, the final view is delivered.
        scenario.record_memory_progress()
        await scenario.service.flush_host_items()
        await _settle()
        final_items = [item for item in scenario.provider.injected if item.kind == "final"]
        assert len(final_items) == 1
        await scenario.begin_response("response-final")
        await scenario.finish_response("response-final", FINAL_TRANSCRIPT)
        scenario.recorder.record(
            "final.response.terminal", {"response_id": "response-final", "status": "completed"}
        )
    finally:
        stop.set()
        await serving
        await scenario.transport.aclose()
    return scenario


async def test_late_transcript_deterministic_backend_satisfies_every_applicable_gate(
    workspace: Path,
) -> None:
    scenario = await run_scenario(workspace)

    report = evaluate_codex_progress_status(scenario.recorder.records, live=False)

    assert report.findings == ()
    assert report.passed
    assert failure_reason(report) is None
    assert report.first_failed_gate is None
    # Gate 6 is live-only: the deterministic backend never runs the fixture command.
    assert [gate.name for gate in report.gates] == [
        "gate1_dispatch_acknowledgement",
        "gate2_real_intermediate_projection",
        "gate3_status_question_during_execution",
        "gate4_informative_status_answer",
        "gate5_final_delivery_separation",
    ]


async def test_first_completed_item_is_silent_and_first_spoken_progress_is_prose(
    workspace: Path,
) -> None:
    """R125: the first count-only item projects nothing; the first projected summary
    already carries worker prose (the plan text), no fact speaks standalone counts,
    and the question still waits for the informative summary."""
    scenario = await run_scenario(workspace)
    records = scenario.recorder.records
    summaries = [
        record["data"]["summary"]
        for record in records
        if record["kind"] == "codex.progress" and "summary" in record["data"]
    ]

    assert len(summaries) >= 2
    assert "先读一遍 event_report 的三个模块" in summaries[0]
    assert is_informative(summaries[-1])

    facts = [record for record in records if record["kind"] == "progress.fact"]
    selected_facts = [
        record
        for record in facts
        if str(record["data"]["event_id"]).startswith("suggestion:")
    ]
    assert len(facts) == 2
    assert len(selected_facts) == 1
    assert summaries[0] not in str(selected_facts[0]["data"]["content"])
    assert summaries[-1] in str(selected_facts[0]["data"]["content"])
    for record in facts:
        content = str(record["data"]["content"])
        assert "仍在处理这个任务" not in content
        if "已执行" in content:
            assert "。" in content.split("（已进行")[0], content

    kinds = [record["kind"] for record in records]
    question = kinds.index("status.question")
    informative_fact = next(
        index
        for index, record in enumerate(records)
        if record["kind"] == "progress.fact" and is_informative(str(record["data"]["content"]))
    )
    terminal_after = next(
        index
        for index, record in enumerate(records)
        if record["kind"] == "progress.response.terminal" and index > informative_fact
    )
    assert informative_fact < terminal_after < question < kinds.index("codex.handoff")


async def test_started_prose_and_final_are_each_spoken(workspace: Path) -> None:
    """Thread-ready, one selected milestone, and final each speak once."""
    scenario = await run_scenario(workspace)
    records = scenario.recorder.records

    started_facts = [
        record
        for record in records
        if record["kind"] == "progress.fact"
        and "已开始处理这个任务" in str(record["data"]["content"])
    ]
    assert len(started_facts) == 1

    progress_facts = [
        str(record["data"]["content"])
        for record in records
        if record["kind"] == "progress.fact"
        and "已开始处理这个任务" not in str(record["data"]["content"])
    ]
    assert len(progress_facts) == 1
    assert "正在实现 event_report 的 parser JSONL 解析" in progress_facts[0]

    final_facts = [record for record in records if record["kind"] == "final.fact"]
    assert len(final_facts) == 1


async def test_sentinels_never_reach_records_memory_or_host_facts(workspace: Path) -> None:
    scenario = await run_scenario(workspace)
    serialized = json.dumps(
        [dict(record) for record in scenario.recorder.records], ensure_ascii=False
    )
    memory_blob = json.dumps(
        [item.content for item in scenario.runtime.memory.channels["codex"].items],
        ensure_ascii=False,
    )
    host_facts = json.dumps(
        [item.content for item in scenario.provider.injected], ensure_ascii=False
    )

    for sentinel in (
        SENTINEL_COMMAND,
        SENTINEL_OUTPUT,
        SENTINEL_REASONING,
        SENTINEL_SECRET,
        str(workspace),
    ):
        assert sentinel not in serialized, sentinel
        assert sentinel not in memory_blob, sentinel
        assert sentinel not in host_facts, sentinel

    # R125: "后台" is no longer a routine register on any spoken surface.
    assert "后台" not in host_facts
    for intent in scenario.provider.response_intents:
        assert "后台" not in intent.item.content

    informative = [
        record["data"]["summary"]
        for record in scenario.recorder.records
        if record["kind"] == "codex.progress" and is_informative(str(record["data"].get("summary")))
    ]
    # The sanitizer replaced the workspace and the credential rather than dropping the
    # whole summary — the counters and the prose both survived.
    assert informative and "[REDACTED]" in informative[-1]


async def test_memory_stores_the_same_summary_the_session_spoke(workspace: Path) -> None:
    scenario = await run_scenario(workspace)
    records = scenario.recorder.records
    projected = [
        record["data"]["summary"]
        for record in records
        if record["kind"] == "codex.progress" and "summary" in record["data"]
    ]
    stored = [
        record["data"]["summary"]
        for record in records
        if record["kind"] == "memory.progress" and "summary" in record["data"]
    ]
    facts = [
        record["data"]["content"]
        for record in records
        if record["kind"] == "progress.fact"
        and str(record["data"]["event_id"]).startswith("suggestion:")
    ]

    assert projected and stored == projected
    assert len(facts) == 1
    assert len(facts) == len(set(facts))
    assert projected[0] not in facts[0]
    assert projected[-1] in facts[0]


async def test_report_mapping_is_json_serializable(workspace: Path) -> None:
    scenario = await run_scenario(workspace)
    report = evaluate_codex_progress_status(scenario.recorder.records, live=False)

    mapping = build_report_mapping(
        report,
        records=scenario.recorder.records,
        manifest={"scenario_version": 2, "backend": "deterministic"},
    )

    assert json.loads(json.dumps(mapping, ensure_ascii=False))["passed"] is True
    assert mapping["failure_reason"] is None


# --------------------------------------------------------------------------------
# Mutation sensitivity. These operate on a synthetic baseline so each mutation is one
# readable edit; ``test_synthetic_baseline_matches_the_live_wiring`` keeps the
# baseline from drifting away from what the real components actually emit.
# --------------------------------------------------------------------------------

BASELINE_SUMMARY = (
    "已执行 1 条命令、已修改 1 处文件。正在实现 event_report 的 parser 解析和 aggregate 去重"
)
BASELINE_PROGRESS_FACT = BASELINE_SUMMARY
BASELINE_FINAL_FACT = f"Codex 报告任务完成：{FINAL_TEXT}"

Entry = tuple[str, dict[str, Any]]


def baseline_entries(*, live: bool) -> list[Entry]:
    entries: list[Entry] = [
        ("user.turn", {"text": WORK_ORDER}),
        (
            "tool.call",
            {"call_id": "call-1", "name": CODEX_RUN_TOOL_NAME, "work_order": WORK_ORDER},
        ),
        ("tool.accepted", {"call_id": "call-1", "delegate_id": "d-1", "state": "accepted"}),
        ("status.transcript", {"response_id": "r-ack", "text": ACK_TRANSCRIPT}),
        ("delegate.running", {"delegate_id": "d-1"}),
        (
            "codex.progress",
            {
                "delegate_id": "d-1",
                "phase": "working",
                "internal_activity": 5,
                "summary": BASELINE_SUMMARY,
            },
        ),
        (
            "memory.progress",
            {"phase": "working", "internal_activity": 5, "summary": BASELINE_SUMMARY},
        ),
        (
            "progress.fact",
            {"event_id": "suggestion:s-progress", "content": BASELINE_PROGRESS_FACT},
        ),
        ("status.transcript", {"response_id": "r-progress", "text": PROGRESS_TRANSCRIPT}),
        ("progress.response.terminal", {"response_id": "r-progress", "status": "completed"}),
        ("status.question", {"text": STATUS_QUESTION}),
        ("codex.handoff", {"delegate_id": "d-1", "outcome": "ok"}),
        ("status.transcript", {"response_id": "r-status", "text": STATUS_ANSWER}),
        ("final.fact", {"event_id": "final:d-1", "content": BASELINE_FINAL_FACT}),
        ("status.transcript", {"response_id": "r-final", "text": FINAL_TRANSCRIPT}),
        ("final.response.terminal", {"response_id": "r-final", "status": "completed"}),
        ("audio.delta", {"response_id": "r-final", "bytes": 4800}),
    ]
    if live:
        entries.extend(
            ("fixture.gate", {"name": name, "passed": True})
            for name in (
                "tests_unchanged",
                "readme_unchanged",
                "changes_within_workspace",
                "harness_test_command_passed",
            )
        )
    return entries


def stamp(entries: list[Entry]) -> list[dict[str, Any]]:
    """Re-issue references and timestamps so a reorder is not also a clock violation."""
    return [
        {
            "event_ref": f"e{index + 1:03d}",
            "t_ms": float(index * 10),
            "kind": kind,
            "data": dict(data),
        }
        for index, (kind, data) in enumerate(entries)
    ]


def find(entries: list[Entry], kind: str, occurrence: int = 0) -> int:
    matches = [index for index, (name, _data) in enumerate(entries) if name == kind]
    return matches[occurrence]


def codes(records: list[dict[str, Any]], *, live: bool = False) -> set[str]:
    return {finding.code for finding in evaluate_codex_progress_status(records, live=live).findings}


def test_synthetic_baseline_passes_both_backends() -> None:
    assert evaluate_codex_progress_status(stamp(baseline_entries(live=False)), live=False).passed
    assert evaluate_codex_progress_status(stamp(baseline_entries(live=True)), live=True).passed


def test_live_work_order_uses_the_contracted_tetris_task() -> None:
    assert "俄罗斯方块" in live_progress.WORK_ORDER
    assert "TASK_CONTRACT.md" in live_progress.WORK_ORDER
    assert "不要只总结合同" in live_progress.WORK_ORDER
    assert "实际创建" in live_progress.WORK_ORDER
    assert "event_report" not in live_progress.WORK_ORDER


async def test_live_recording_bridge_keeps_actual_work_order_and_delegate_timing() -> None:
    recorder = ScenarioRecorder(clock=VirtualClock())
    delegates: list[str] = []

    class _Bridge:
        async def accept_tool_call(self, event: object) -> SimpleNamespace:
            delegate_id = "d-live" if event.name == "codex__run" else "d-status"
            return SimpleNamespace(accepted=True, delegate_id=delegate_id)

    bridge = live_progress.RecordingBridge(
        _Bridge(),
        recorder,
        on_delegate=delegates.append,
    )
    event = SimpleNamespace(
        call_id="call-live",
        name="codex__run",
        arguments={"work_order": "真实模型生成的工作单"},
    )

    await bridge.accept_tool_call(event)
    await bridge.accept_tool_call(
        SimpleNamespace(
            call_id="call-status",
            name="codex__status",
            arguments={},
        )
    )

    assert delegates == ["d-live"]
    assert recorder.records[0]["data"]["work_order"] == "真实模型生成的工作单"


def test_live_evaluator_accepts_the_tetris_artifact_gate_set() -> None:
    entries = baseline_entries(live=False)
    entries.extend(
        ("fixture.gate", {"name": name, "passed": True})
        for name in live_progress.REQUIRED_TETRIS_GATES
    )

    report = evaluate_codex_progress_status(
        stamp(entries),
        live=True,
        required_fixture_gates=live_progress.REQUIRED_TETRIS_GATES,
    )

    assert report.passed


async def test_live_attempt_wires_real_tetris_checker_into_gate6(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _LiveRun:
        def __init__(self, *, workspace: Path, audio: Path, timeout: float) -> None:
            del audio, timeout
            self.workspace = workspace
            self.recorder = ScenarioRecorder(clock=VirtualClock())
            for kind, data in baseline_entries(live=False):
                self.recorder.record(kind, data)
            self.early_stop = None

        def build(self, _settings: object) -> None:
            return None

        async def run(self) -> None:
            write_reference_tetris(self.workspace)

    monkeypatch.setattr(live_progress, "LiveRun", _LiveRun)
    monkeypatch.setattr(
        live_progress,
        "_preflight",
        lambda _settings: {
            "realtime_endpoint_host": "example.invalid",
            "realtime_model": "test-model",
            "realtime_voice": "test-voice",
            "codex_binary": "codex",
            "codex_binary_version": "test",
        },
    )
    output = tmp_path / "live-attempt"

    result = await live_progress._attempt(
        SimpleNamespace(output=output, timeout=300.0),
        attempt=1,
    )

    report = json.loads((output / "attempt-1" / "report.json").read_text(encoding="utf-8"))
    assert result == live_progress.EXIT_PASS
    assert report["passed"] is True
    assert report["manifest"]["scenario_version"] == 2
    assert report["first_failed_gate"] is None
    assert {gate["name"] for gate in report["fixture_verification"]["gates"]} == {
        "build_and_start",
        "core_tetris_behavior",
        "steered_speed_control",
        "workspace_hygiene",
    }
    assert all(gate["passed"] for gate in report["fixture_verification"]["gates"])
    assert "tests_ran" not in report["fixture_verification"]
    assert "cmd_passed" not in report["fixture_verification"]


def test_harness_invalid_attempt_keeps_partial_diagnostics(tmp_path: Path) -> None:
    recorder = ScenarioRecorder(clock=VirtualClock())
    recorder.record("user.turn", {"text": "写一个俄罗斯方块游戏"})
    directory = tmp_path / "attempt-1"
    manifest = {"scenario_id": live_progress.SCENARIO_ID, "attempt": 1}

    live_progress._write_harness_invalid_artifacts(
        directory,
        manifest=manifest,
        records=recorder.records,
        reason="fixture_too_fast",
    )

    stored_manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    report = json.loads((directory / "report.json").read_text(encoding="utf-8"))
    events = (directory / "events.ndjson").read_text(encoding="utf-8").splitlines()
    assert stored_manifest == manifest
    assert len(events) == 1
    assert json.loads(events[0])["kind"] == "user.turn"
    assert report["status"] == "harness_invalid"
    assert report["passed"] is False
    assert report["failure_reason"] == "fixture_too_fast"
    assert report["event_count"] == 1
    assert report["event_refs"] == ["e001"]


def test_live_delivery_normalizes_multiline_transcript(tmp_path: Path) -> None:
    run = live_progress.LiveRun(workspace=tmp_path, audio=tmp_path, timeout=1.0)

    run._on_delivery(
        PlaybackCompletion(
            session_epoch=1,
            response_id="response-status",
            utterance_id="utterance-status",
            generation_epoch=1,
            text="正在实现 parser。\n接下来处理 aggregate。",
            disposition="spoken",
            started=True,
            played_ms=1_000,
        )
    )

    assert run.recorder.records[-1]["data"]["text"] == ("正在实现 parser。 接下来处理 aggregate。")


def test_live_delivery_records_selected_suggestion_as_progress_terminal(tmp_path: Path) -> None:
    run = live_progress.LiveRun(workspace=tmp_path, audio=tmp_path, timeout=1.0)
    run.telemetry.response_event_ids["response-progress"] = "suggestion:s-progress"

    run._on_delivery(
        PlaybackCompletion(
            session_epoch=1,
            response_id="response-progress",
            utterance_id="utterance-progress",
            generation_epoch=1,
            text="Codex 已经完成 parser，正在继续 aggregate。",
            disposition="spoken",
            started=True,
            played_ms=1_000,
        )
    )

    assert [record["kind"] for record in run.recorder.records] == [
        "status.transcript",
        "progress.response.terminal",
    ]


async def test_live_speech_appends_vad_closing_silence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sent: list[bytes] = []

    class _Service:
        async def send_audio(self, pcm: bytes) -> None:
            sent.append(pcm)

    monkeypatch.setattr(live_progress, "CHUNK_SECONDS", 0.0)
    run = live_progress.LiveRun(workspace=tmp_path, audio=tmp_path, timeout=1.0)
    run.assembly = SimpleNamespace(service=_Service())
    speech = b"\x01" * live_progress.CHUNK_BYTES

    await run._speak(speech)

    silence = b"\x00" * live_progress.CHUNK_BYTES
    assert sent == [speech] + [silence] * 25


async def test_live_speech_can_extend_silence_for_short_status_question(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sent: list[bytes] = []

    class _Service:
        async def send_audio(self, pcm: bytes) -> None:
            sent.append(pcm)

    monkeypatch.setattr(live_progress, "CHUNK_SECONDS", 0.0)
    run = live_progress.LiveRun(workspace=tmp_path, audio=tmp_path, timeout=1.0)
    run.assembly = SimpleNamespace(service=_Service())
    speech = b"\x01" * live_progress.CHUNK_BYTES

    await run._speak(
        speech,
        trailing_silence_chunks=live_progress.STATUS_TRAILING_SILENCE_CHUNKS,
    )

    silence = b"\x00" * live_progress.CHUNK_BYTES
    assert live_progress.STATUS_TRAILING_SILENCE_CHUNKS >= 75
    assert sent == [speech] + [silence] * live_progress.STATUS_TRAILING_SILENCE_CHUNKS


async def test_live_wait_aborts_when_realtime_session_stops(tmp_path: Path) -> None:
    class _Service:
        async def wait_stopped(self) -> None:
            return None

    run = live_progress.LiveRun(workspace=tmp_path, audio=tmp_path, timeout=60.0)
    run.assembly = SimpleNamespace(service=_Service())
    run._deadline = run.recorder.now() + 60.0

    with pytest.raises(live_progress.HarnessInvalid, match="realtime_session_stopped"):
        await run._wait_for_record("tool.accepted")


@pytest.mark.parametrize(
    ("summary", "expected"),
    (
        ("正在实现 event_report parser 并处理 aggregate 去重", "gate_violation"),
        ("已执行 3 条命令", "no_worker_narration"),
    ),
)
async def test_live_window_classifies_unselected_summary(
    tmp_path: Path, summary: str, expected: str
) -> None:
    class _Service:
        async def wait_stopped(self) -> None:
            await asyncio.Event().wait()

    run = live_progress.LiveRun(workspace=tmp_path, audio=tmp_path, timeout=1.0)
    run.delegate_id = "d-1"
    run.assembly = SimpleNamespace(service=_Service())
    run._deadline = run.recorder.now() + 1.0
    run.recorder.record(
        "codex.progress",
        {
            "delegate_id": "d-1",
            "phase": "working",
            "internal_activity": 1,
            "summary": summary,
        },
    )
    run.recorder.record("codex.handoff", {"delegate_id": "d-1", "outcome": "ok"})

    assert await run._await_informative_window() == {}
    assert run.early_stop == expected


async def test_live_window_without_any_summary_remains_fixture_too_fast(tmp_path: Path) -> None:
    class _Service:
        async def wait_stopped(self) -> None:
            await asyncio.Event().wait()

    run = live_progress.LiveRun(workspace=tmp_path, audio=tmp_path, timeout=1.0)
    run.delegate_id = "d-1"
    run.assembly = SimpleNamespace(service=_Service())
    run._deadline = run.recorder.now() + 1.0
    run.recorder.record(
        "codex.progress",
        {"delegate_id": "d-1", "phase": "working", "internal_activity": 1},
    )
    run.recorder.record("codex.handoff", {"delegate_id": "d-1", "outcome": "ok"})

    with pytest.raises(live_progress.HarnessInvalid, match="fixture_too_fast"):
        await run._await_informative_window()
    assert run.early_stop is None


async def test_synthetic_baseline_matches_the_live_wiring(workspace: Path) -> None:
    """A drift guard: the mutation baseline must cover what the real run emits."""
    scenario = await run_scenario(workspace)

    produced = {record["kind"] for record in scenario.recorder.records}
    synthetic = {kind for kind, _data in baseline_entries(live=False)}

    assert produced == synthetic
    progress = next(
        record
        for record in scenario.recorder.records
        if record["kind"] == "progress.fact"
        and str(record["data"]["event_id"]).startswith("suggestion:")
    )
    assert str(progress["data"]["event_id"]).startswith("suggestion:")


def test_thread_ready_lifecycle_fact_is_allowed_without_surrogate_selection() -> None:
    entries = baseline_entries(live=False)
    entries.insert(
        find(entries, "codex.progress"),
        (
            "progress.fact",
            {
                "event_id": "progress:d-1:started:0",
                "content": "Codex 已开始处理这个任务。",
            },
        ),
    )

    assert evaluate_codex_progress_status(stamp(entries), live=False).passed


def test_old_direct_progress_fact_is_rejected() -> None:
    entries = baseline_entries(live=False)
    entries[find(entries, "progress.fact")][1]["event_id"] = "progress:d-1:working:5"

    assert "progress_fact_not_surrogate_selected" in codes(stamp(entries))


def test_generic_selected_progress_fact_is_rejected() -> None:
    entries = baseline_entries(live=False)
    entries[find(entries, "progress.fact")][1]["content"] = "Codex 仍在处理这个任务。"

    assert "selected_progress_not_informative" in codes(stamp(entries))


def test_speech_prepared_selected_progress_remains_grounded() -> None:
    entries = baseline_entries(live=False)
    raw_summary = (
        "**正在实现** [`event_report` parser](https://example.invalid/parser)，"
        "并处理 aggregate 去重；详情 https://example.invalid/status"
    )
    expected = "正在实现 event_report parser，并处理 aggregate 去重；详情 （链接略）"
    prepared, clipped = prepare_for_speech(raw_summary, limit=SPEECH_FINAL_LIMIT)
    assert (prepared, clipped) == (expected, False)
    entries[find(entries, "codex.progress")][1]["summary"] = raw_summary
    entries[find(entries, "memory.progress")][1]["summary"] = raw_summary
    entries[find(entries, "progress.fact")][1]["content"] = prepared

    report = evaluate_codex_progress_status(stamp(entries), live=False)
    projection = next(gate for gate in report.gates if gate.name == GATE_PROJECTION)

    assert projection.passed


def test_informative_progress_without_selected_fact_is_rejected() -> None:
    entries = baseline_entries(live=False)
    entries.pop(find(entries, "progress.fact"))

    report = evaluate_codex_progress_status(stamp(entries), live=False)
    projection = next(gate for gate in report.gates if gate.name == GATE_PROJECTION)

    assert "selected_progress_missing" in {finding.code for finding in projection.findings}
    assert failure_reason(report) == "gate_violation"


def test_mutation_1_dropping_the_summary_before_memory_is_caught() -> None:
    entries = baseline_entries(live=False)
    entries[find(entries, "memory.progress")][1].pop("summary")

    assert "progress_summary_absent_from_memory" in codes(stamp(entries))


def test_mutation_2_counts_only_prose_is_caught_and_named_no_worker_narration() -> None:
    entries = baseline_entries(live=False)
    counts_only = "已执行 3 条命令"
    entries[find(entries, "codex.progress")][1]["summary"] = counts_only
    entries[find(entries, "memory.progress")][1]["summary"] = counts_only
    entries[find(entries, "progress.fact")][1]["content"] = f"Codex 正在执行：{counts_only}"

    report = evaluate_codex_progress_status(stamp(entries), live=False)

    assert "progress_summary_not_informative" in {f.code for f in report.findings}
    assert failure_reason(report) == "no_worker_narration"


def test_mutation_3_leaking_a_sentinel_into_the_summary_is_caught() -> None:
    entries = baseline_entries(live=False)
    leaked = f"{BASELINE_SUMMARY}，见 /Users/nova/secret-workspace/event_report"
    entries[find(entries, "codex.progress")][1]["summary"] = leaked

    assert "progress_summary_leaked_forbidden_content" in codes(stamp(entries))


def test_mutation_3b_leaking_a_credential_into_the_progress_fact_is_caught() -> None:
    entries = baseline_entries(live=False)
    entries[find(entries, "progress.fact")][1]["content"] = (
        f"{BASELINE_PROGRESS_FACT}（凭据 {SENTINEL_SECRET}）"
    )

    assert "progress_summary_leaked_forbidden_content" in codes(stamp(entries))


def test_mutation_3c_protocol_field_fallback_in_progress_fact_is_caught() -> None:
    entries = baseline_entries(live=False)
    entries[find(entries, "progress.fact")][1]["content"] = (
        "Codex 正在执行：phase=started, internal_activity=0, elapsed=0.00s"
    )

    assert "progress_summary_leaked_forbidden_content" in codes(stamp(entries))


def test_mutation_4_a_generic_status_answer_is_caught() -> None:
    entries = baseline_entries(live=False)
    entries[find(entries, "status.transcript", 2)][1]["text"] = "还在运行，请稍等。"

    assert "status_answer_generic_only" in codes(stamp(entries))


def test_a_status_answer_repeating_only_the_task_name_is_not_grounded() -> None:
    entries = baseline_entries(live=False)
    entries[find(entries, "status.transcript", 2)][1]["text"] = "正在处理 event_report 任务。"

    assert "status_answer_not_grounded" in codes(stamp(entries))


def test_mutation_5_an_answer_claiming_completion_is_caught() -> None:
    entries = baseline_entries(live=False)
    entries[find(entries, "status.transcript", 2)][1]["text"] = (
        "parser 的解析已完成，测试全部通过。"
    )

    assert "status_answer_claims_completion" in codes(stamp(entries))


def test_mutation_6_a_final_fact_inside_the_active_status_response_is_caught() -> None:
    entries = baseline_entries(live=False)
    final_fact = entries.pop(find(entries, "final.fact"))
    entries.insert(find(entries, "status.transcript", 2), final_fact)

    assert "final_fact_entered_active_status_response" in codes(stamp(entries))


def test_mutation_7_duplicate_progress_facts_are_caught() -> None:
    entries = baseline_entries(live=False)
    index = find(entries, "progress.fact")
    entries.insert(index + 1, ("progress.fact", dict(entries[index][1])))

    assert "duplicate_progress_fact" in codes(stamp(entries))


def test_mutation_7b_duplicate_final_facts_are_caught() -> None:
    entries = baseline_entries(live=False)
    index = find(entries, "final.fact")
    entries.insert(index + 1, ("final.fact", dict(entries[index][1])))

    assert "duplicate_final_fact" in codes(stamp(entries))


def test_mutation_8_a_failed_fixture_gate_defeats_a_successful_handoff() -> None:
    entries = baseline_entries(live=True)
    index = next(
        position
        for position, (kind, data) in enumerate(entries)
        if kind == "fixture.gate" and data["name"] == "harness_test_command_passed"
    )
    entries[index][1]["passed"] = False

    report = evaluate_codex_progress_status(stamp(entries), live=True)

    # Codex still reported ok; only the harness's own verification says otherwise.
    assert entries[find(entries, "codex.handoff")][1]["outcome"] == "ok"
    assert "fixture_gate_failed" in {finding.code for finding in report.findings}
    assert report.first_failed_gate == "gate6_independent_fixture_verification"


def test_a_missing_fixture_gate_is_caught_only_on_the_live_backend() -> None:
    entries = [entry for entry in baseline_entries(live=True) if entry[0] != "fixture.gate"]

    assert "fixture_gate_missing" in codes(stamp(entries), live=True)
    assert evaluate_codex_progress_status(stamp(entries), live=False).passed


def test_an_acknowledgement_claiming_completion_is_caught() -> None:
    entries = baseline_entries(live=False)
    entries[find(entries, "status.transcript")][1]["text"] = "好了，已经完成了。"

    assert "ack_claims_completion" in codes(stamp(entries))


def test_an_acknowledgement_promising_to_complete_is_not_a_completion_claim() -> None:
    entries = baseline_entries(live=False)
    entries[find(entries, "status.transcript")][1]["text"] = (
        "我来帮您完成这个任务，先读取合同，再开始实现。"
    )

    assert "ack_claims_completion" not in codes(stamp(entries))


def test_a_standalone_completion_acknowledgement_is_caught() -> None:
    entries = baseline_entries(live=False)
    entries[find(entries, "status.transcript")][1]["text"] = "完成。"

    assert "ack_claims_completion" in codes(stamp(entries))


def test_readonly_status_tool_does_not_count_as_a_second_run_or_handoff() -> None:
    entries = baseline_entries(live=False)
    status_question = find(entries, "status.question")
    entries[status_question + 1 : status_question + 1] = [
        ("tool.call", {"call_id": "call-status", "name": "codex__status", "work_order": ""}),
        (
            "tool.accepted",
            {"call_id": "call-status", "delegate_id": "d-status", "state": "accepted"},
        ),
        ("codex.handoff", {"delegate_id": "d-status", "outcome": "ok"}),
    ]

    assert evaluate_codex_progress_status(stamp(entries), live=False).passed


def test_protocol_envelope_in_any_spoken_progress_transcript_is_caught() -> None:
    entries = baseline_entries(live=False)
    progress_transcript = find(entries, "status.transcript", 1)
    entries[progress_transcript][1]["text"] += " <nova_progress_event> provenance=host"

    assert "spoken_transcript_recites_protocol" in codes(stamp(entries))


def test_a_status_question_before_the_progress_response_terminal_is_caught() -> None:
    entries = baseline_entries(live=False)
    terminal = entries.pop(find(entries, "progress.response.terminal"))
    entries.insert(find(entries, "status.question") + 1, terminal)

    assert "status_question_before_progress_response_terminal" in codes(stamp(entries))


def test_a_handoff_before_the_status_question_is_caught() -> None:
    entries = baseline_entries(live=False)
    handoff = entries.pop(find(entries, "codex.handoff"))
    entries.insert(find(entries, "status.question"), handoff)

    assert "handoff_before_status_question" in codes(stamp(entries))


def test_a_raw_handoff_envelope_as_the_final_fact_is_caught() -> None:
    entries = baseline_entries(live=False)
    entries[find(entries, "final.fact")][1]["content"] = json.dumps(
        {"outcome": "ok", "sha256": "0" * 64}, ensure_ascii=False
    )

    assert "final_fact_not_speech_view" in codes(stamp(entries))


def test_a_live_final_response_without_audio_is_caught() -> None:
    entries = [entry for entry in baseline_entries(live=True) if entry[0] != "audio.delta"]

    assert "final_response_audio_missing" in codes(stamp(entries), live=True)


def test_live_audio_event_itself_proves_delivery_when_large_byte_count_is_omitted() -> None:
    entries = baseline_entries(live=True)
    entries[find(entries, "audio.delta")][1].pop("bytes")

    assert evaluate_codex_progress_status(stamp(entries), live=True).passed


def test_reusing_the_acknowledgement_response_for_the_status_answer_is_caught() -> None:
    entries = baseline_entries(live=False)
    entries[find(entries, "status.transcript", 2)][1]["response_id"] = "r-ack"

    assert "status_response_id_reused" in codes(stamp(entries))


def test_weak_concepts_alone_never_make_a_summary_informative() -> None:
    assert not is_informative("正在跑测试")
    assert not is_informative("running tests")
    assert not is_informative("已执行 1 条命令")
    assert not is_informative("正在处理俄罗斯方块任务")
    assert not is_informative("正在处理方块任务")
    assert is_informative("正在跑 parser 的测试")
    assert is_informative("聚合去重已经写好")
    assert is_informative("正在实现俄罗斯方块引擎")


# --------------------------------------------------------------------------------
# The fixture itself. Gate 6 is only meaningful if the fixture starts red, so that
# property is pinned here rather than left to the live run to discover.
# --------------------------------------------------------------------------------


def test_the_copied_fixture_has_the_documented_layout(workspace: Path) -> None:
    present = {
        path.relative_to(workspace).as_posix() for path in workspace.rglob("*") if path.is_file()
    }

    assert present == {
        "README.md",
        "event_report/__init__.py",
        "event_report/aggregate.py",
        "event_report/parser.py",
        "event_report/render.py",
        "tests/__init__.py",
        "tests/test_aggregate.py",
        "tests/test_parser.py",
        "tests/test_render.py",
    }


@pytest.mark.real_time
def test_the_pristine_fixture_fails_its_own_suite(workspace: Path) -> None:
    """A fixture that already passed would make every Gate 6 green for free."""
    result = run_fixture_tests(workspace, timeout=120.0)

    assert result.passed is False
    assert result.reason == "test_command_failed"
    # Discovery still worked; the suite is red because the TODOs raise, not because
    # `python -m unittest` found nothing to run.
    assert result.ran == EXPECTED_FIXTURE_TESTS


def test_verification_gates_catch_a_rewritten_test_file_and_a_rewritten_readme(
    workspace: Path,
) -> None:
    before = workspace_hashes(workspace)
    (workspace / "tests" / "test_render.py").write_text("# gutted\n", encoding="utf-8")
    (workspace / "README.md").write_text("# rewritten\n", encoding="utf-8")
    (workspace / "event_report" / "parser.py").write_text("# legitimate edit\n", encoding="utf-8")

    gates = {
        gate.name: gate
        for gate in verify_workspace(
            workspace,
            before=before,
            test_run=FixtureTestRun(passed=True, ran=EXPECTED_FIXTURE_TESTS, reason="ok"),
        )
    }

    assert gates["tests_unchanged"].passed is False
    assert gates["readme_unchanged"].passed is False
    # Editing the production package is exactly what the worker is asked to do.
    assert gates["changes_within_workspace"].passed is True
    assert changed_paths(before, workspace_hashes(workspace)) == (
        "README.md",
        "event_report/parser.py",
        "tests/test_render.py",
    )


def test_a_deleted_suite_cannot_pass_by_exiting_zero(workspace: Path) -> None:
    """``python -m unittest`` exits 0 after discovering nothing, so count is a gate."""
    before = workspace_hashes(workspace)
    empty = FixtureTestRun(passed=False, ran=0, reason="too_few_tests_discovered")

    gates = {gate.name: gate for gate in verify_workspace(workspace, before=before, test_run=empty)}

    assert gates["harness_test_command_passed"].passed is False
    assert gates["harness_test_command_passed"].findings == ("too_few_tests_discovered:ran=0",)
    # Nothing else went red: the suite result is an independent axis from the hashes.
    assert all(gate.passed for name, gate in gates.items() if name != "harness_test_command_passed")
