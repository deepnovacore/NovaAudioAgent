from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import FrozenInstanceError, replace
from itertools import count

import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.calls import AttentionDecision, AttentionTrigger, WatchRecord
from nova_audio_agent.events import (
    Deadline,
    HandoffEvent,
    ObservationEvent,
    ProgressEvent,
    UserInput,
    WakeReason,
)
from nova_audio_agent.executors.codex import CODEX_MANIFEST, CODEX_POLICY
from nova_audio_agent.realtime.bridge import RealtimeRuntimeBridge, ToolAcceptance
from nova_audio_agent.realtime.playback import PlaybackFrame, PlaybackGeneration, PlaybackRegistry
from nova_audio_agent.realtime.recall import compile_memory_recall
from nova_audio_agent.realtime.protocol import (
    HostContextItem,
    HostResponseIntent,
    ItemDeliveryUncertainError,
    ItemIdentity,
    ProviderErrorEvent,
    RealtimeFrontBrainEvent,
    ResponseAudioDelta,
    ResponseCancelRejected,
    ResponseStarted,
    ResponseTerminal,
    ResponseTranscriptFinal,
    SessionIdentity,
    ToolCallReady,
    UserSpeechEnded,
    UserSpeechStarted,
    UserTranscriptFailed,
    UserTranscriptFinal,
)
from nova_audio_agent.realtime.protocol import ResponseTranscriptDelta
from nova_audio_agent.realtime import service as realtime_service
from nova_audio_agent.realtime.service import (
    GUARD_ALERT_DEADLINE_S,
    GUARD_CLEAR_ACK_DEADLINE_S,
    MAX_HOST_FACT_CHARS,
    RealtimeService,
    _SemanticAcknowledgement,
)
from nova_audio_agent.realtime.session import (
    CaptionFrame,
    HostResponseDelivery,
    RealtimeDeliveryError,
    RealtimeSession,
)
from nova_audio_agent.realtime.project_confirmation import ProjectConfirmationController
from nova_audio_agent.executors.codex_project_live import ProjectCommitResult
from nova_audio_agent.memory import CONVERSATION_CHANNEL, USER_PRIORITY, HandoffPolicy, Memory
from nova_audio_agent.ports import Delegate, ExecutorManifest, OpSpec, SurrogateOutput
from nova_audio_agent.runtime import Runtime, _wake_handoff
from nova_audio_agent.suggestions import Suggestion
from nova_audio_agent.tool_schema import CompiledTools, ToolBinding, compile_tool_schema


def ids(*values: str) -> Iterator[str]:
    return iter(values)


class FakeProvider:
    def __init__(self) -> None:
        self.epoch = 0
        self.actions: list[str] = []
        self.connected_tools: list[tuple[dict[str, object], ...]] = []
        self.injected: list[HostContextItem] = []
        self.injected_epochs: list[int] = []
        self.response_intents: list[HostResponseIntent] = []
        self.response_epochs: list[int] = []
        self.inject_attempts = 0
        self.inject_failures = 0
        self.inject_failure_attempts: set[int] = set()
        self.uncertain_inject_attempts: set[int] = set()
        self.response_failures = 0
        self.confirmation_timeouts: list[float | None] = []
        self.user_activations: list[bool] = []

    async def connect(self, *, tools: tuple[dict[str, object], ...]) -> SessionIdentity:
        self.epoch += 1
        self.connected_tools.append(tools)
        self.actions.append(f"connect:{len(tools)}")
        return SessionIdentity(self.epoch, f"session-{self.epoch}")

    async def send_audio(self, pcm: bytes) -> None:
        self.actions.append(f"audio:{len(pcm)}")

    async def inject_host_item(
        self,
        item: HostContextItem,
        *,
        confirmation_timeout: float | None = None,
        as_user_activation: bool = False,
    ) -> ItemIdentity:
        self.inject_attempts += 1
        self.confirmation_timeouts.append(confirmation_timeout)
        self.user_activations.append(as_user_activation)
        if self.inject_attempts in self.uncertain_inject_attempts:
            self.actions.append(f"inject_uncertain:{item.kind}:{item.event_id}")
            raise ItemDeliveryUncertainError(
                session_epoch=self.epoch,
                host_item_id=item.host_item_id,
                provider_item_id=f"provider-{item.host_item_id}",
                item_kind=item.kind,
            )
        if self.inject_attempts in self.inject_failure_attempts:
            raise RuntimeError("inject failed")
        if self.inject_failures:
            self.inject_failures -= 1
            raise RuntimeError("inject failed")
        self.injected.append(item)
        self.injected_epochs.append(self.epoch)
        self.actions.append(f"inject:{item.kind}:{item.event_id}")
        return ItemIdentity(self.epoch, item.host_item_id, f"provider-{item.host_item_id}")

    async def create_response(self, intent: HostResponseIntent) -> None:
        self.actions.append("create_response")
        if self.response_failures:
            self.response_failures -= 1
            raise RuntimeError("response failed")
        self.response_intents.append(intent)
        self.response_epochs.append(self.epoch)

    async def cancel_response(self, response_id: str) -> None:
        self.actions.append(f"cancel:{response_id}")

    async def close(self) -> None:
        self.actions.append("close")

    async def events(self) -> AsyncIterator[RealtimeFrontBrainEvent]:
        if False:
            yield ResponseStarted(session_epoch=1, response_id="unused")


class FakeExecutor:
    def __init__(
        self,
        name: str,
        *,
        ops: tuple[OpSpec, ...] = (),
        priority: int = 0,
        suggest: bool = False,
    ) -> None:
        self.manifest = ExecutorManifest(
            name=name,
            ops=ops,
            policy=HandoffPolicy(
                channel=name,
                priority=priority,
                wake="none",
                typical_latency=0.0,
                compress_watermark=1,
                suggest=suggest,
            ),
        )


WATCH_START = OpSpec(
    name="start",
    description="在后台等待监控条件",
    params={
        "type": "object",
        "properties": {"condition": {"type": "string"}},
        "required": ["condition"],
        "additionalProperties": False,
    },
    readonly=True,
)


class FakeDelegateLedger:
    def __init__(self) -> None:
        self._delegates: dict[str, Delegate] = {}
        self._settled: dict[str, Delegate] = {}
        self._terminated: dict[str, Deadline] = {}
        self._observer_handoff_claim: tuple[HandoffEvent, Delegate] | None = None

    def bind(self, delegate_id: str, *, executor: str, op: str) -> None:
        delegate = Delegate(
            delegate_id=delegate_id,
            executor=executor,
            op=op,
            request={},
            origin_ref="conversation:1",
            deadline=0.0,
            routing_class="user_awaited",
            dispatched_at=0.0,
        )
        self._delegates[delegate_id] = delegate
        self._settled.pop(delegate_id, None)

    def find(self, delegate_id: str) -> Delegate | None:
        return self._delegates.get(delegate_id) or self._settled.get(delegate_id)

    def authorize_handoff(self, event: HandoffEvent, *, op: str = "start") -> Delegate:
        delegate = self.find(event.delegate_id)
        if delegate is None:
            self.bind(event.delegate_id, executor=event.channel, op=op)
            delegate = self.find(event.delegate_id)
        assert delegate is not None
        self._observer_handoff_claim = (event, delegate)
        return delegate

    def claimed_handoff(self, event: HandoffEvent) -> Delegate | None:
        claim = self._observer_handoff_claim
        return None if claim is None or claim[0] is not event else claim[1]

    def in_flight_delegate(self, delegate_id: str) -> Delegate | None:
        return self._delegates.get(delegate_id)

    def settle(self, delegate_id: str) -> None:
        delegate = self._delegates.pop(delegate_id, None)
        if delegate is not None:
            self._settled[delegate_id] = delegate

    def terminate_with_deadline(
        self,
        event: Deadline,
        *,
        executor: str,
        op: str,
    ) -> None:
        self.bind(event.delegate_id, executor=executor, op=op)
        self.settle(event.delegate_id)
        self._terminated[event.delegate_id] = event

    def terminated_by(self, delegate_id: str) -> str | None:
        return "deadline" if delegate_id in self._terminated else None

    def terminated_by_deadline(self, event: Deadline) -> bool:
        return self._terminated.get(event.delegate_id) is event


class FakeRuntime:
    def __init__(
        self,
        *,
        clock: VirtualClock | None = None,
        executor_names: tuple[str, ...] = ("codex",),
    ) -> None:
        self.posted: list[object] = []
        self.observer: Callable[[object], None] | None = None
        self.clock = VirtualClock() if clock is None else clock
        self.executors = {name: FakeExecutor(name) for name in executor_names}
        self.delegates = FakeDelegateLedger()

    def post(self, event: object) -> object:
        self.posted.append(event)
        return event

    def observe(self, observer: Callable[[object], None]) -> Callable[[], None]:
        self.observer = observer
        return lambda: setattr(self, "observer", None)

    async def serve(self, stop) -> None:
        await stop.wait()


class FakeBridge:
    def __init__(
        self,
        acceptance: ToolAcceptance | dict[str, ToolAcceptance],
        *,
        runtime: FakeRuntime,
    ) -> None:
        self.acceptance = acceptance
        self.runtime = runtime
        self.calls: list[ToolCallReady] = []
        self.origin_refs: list[str | None] = []

    async def accept_user_transcript(self, text: str) -> str:
        self.runtime.post(UserInput(text=text))
        return f"conversation:{len(self.runtime.posted)}"

    async def accept_tool_call(
        self,
        call: ToolCallReady,
        *,
        origin_ref: str | None = None,
    ) -> ToolAcceptance:
        self.calls.append(call)
        self.origin_refs.append(origin_ref)
        if isinstance(self.acceptance, dict):
            return self.acceptance[call.call_id]
        return self.acceptance


def make_service(
    *,
    terminals: list[tuple[str, int]] | None = None,
    on_codex_state: Callable[[str], None] | None = None,
    id_factory: Callable[[], str] | None = None,
    clock: VirtualClock | None = None,
    captions: list[CaptionFrame] | None = None,
    telemetry: object | None = None,
    alerts: list[tuple[str | None, int | None]] | None = None,
    executor_names: tuple[str, ...] = ("codex",),
    runtime: Runtime | None = None,
    provider_schemas: tuple[dict[str, object], ...] | None = None,
    controlled_guard_reconnect: bool = False,
    guard_history_recovery: str = "none",
    project_confirmation: ProjectConfirmationController | None = None,
    commit_project_operation: Callable[..., object] | None = None,
) -> tuple[RealtimeService, FakeProvider, FakeRuntime | Runtime, list[PlaybackFrame]]:
    provider = FakeProvider()
    effective_clock = (
        runtime.clock if runtime is not None else VirtualClock() if clock is None else clock
    )
    effective_runtime: FakeRuntime | Runtime = (
        runtime
        if runtime is not None
        else FakeRuntime(clock=effective_clock, executor_names=executor_names)
    )
    if isinstance(effective_runtime, FakeRuntime):
        for delegate_id in ("d-1", "d-2"):
            effective_runtime.delegates.bind(delegate_id, executor="codex", op="run")
    frames: list[PlaybackFrame] = []
    service_ids = ids(
        "host-progress",
        "host-final",
        "host-extra",
        "host-recovery",
        "host-more-1",
        "host-more-2",
    )
    playback_ids = ids(
        "generation-progress",
        "utterance-progress",
        "generation-final",
        "utterance-final",
        "generation-extra",
        "utterance-extra",
    )
    next_service_id = (lambda: next(service_ids)) if id_factory is None else id_factory
    playback = PlaybackRegistry(
        id_factory=lambda: next(playback_ids),
        on_frame=frames.append,
        on_clear=lambda utterance_id, epoch: provider.actions.append(
            f"clear:{utterance_id}:{epoch}"
        ),
        on_alert=(
            None
            if alerts is None
            else lambda utterance_id, epoch: alerts.append((utterance_id, epoch))
        ),
    )
    session = RealtimeSession(
        provider=provider,
        playback=playback,
        id_factory=next_service_id,
        on_spoken=lambda text: provider.actions.append(f"spoken:{text}"),
        on_delivery=lambda completion: provider.actions.append(
            f"delivery:{completion.disposition}:{completion.text}"
        ),
        clock=effective_clock,
    )
    tool_output = HostContextItem.tool_output(
        host_item_id="host-tool",
        event_id="event-tool",
        call_id="call-1",
        content='{"state":"accepted"}',
    )
    acceptance = ToolAcceptance(
        accepted=True,
        code="accepted",
        delegate_id="d-1",
        host_item=tool_output,
        response_intent=HostResponseIntent.delegation_acknowledgement(
            item=tool_output,
            task_summary="实现俄罗斯方块",
        ),
        executor="codex",
    )
    service = RealtimeService(
        provider=provider,
        runtime=effective_runtime,  # type: ignore[arg-type]
        tools=CompiledTools(
            schemas=(),
            bindings={
                "codex__run": ToolBinding(
                    kind="delegate",
                    logical_name="codex.run",
                    executor="codex",
                    op="run",
                )
            },
        ),
        provider_schemas=provider_schemas,
        session=session,
        bridge=FakeBridge(acceptance, runtime=effective_runtime),  # type: ignore[arg-type]
        id_factory=next_service_id,
        on_provider_terminal=lambda generation: (
            terminals.append((generation.utterance_id, generation.generation_epoch))
            if terminals is not None
            else None
        ),
        on_codex_state=on_codex_state,
        on_caption=captions.append if captions is not None else None,
        telemetry=telemetry,  # type: ignore[arg-type]
        **({"controlled_guard_reconnect": True} if controlled_guard_reconnect else {}),
        guard_history_recovery=guard_history_recovery,  # type: ignore[arg-type]
        project_confirmation=project_confirmation,
        commit_project_operation=commit_project_operation,  # type: ignore[arg-type]
    )
    return service, provider, effective_runtime, frames


def make_policy_enabled_codex_service(
    *, telemetry: object | None = None
) -> tuple[RealtimeService, Runtime, FakeProvider]:
    suggestion_outlet: list[Callable[[Suggestion, WakeReason], None]] = []
    runtime = Runtime(
        clock=VirtualClock(),
        memory=Memory(policies=(CODEX_POLICY,)),
        on_suggestion_selected=lambda suggestion, reason: suggestion_outlet[0](suggestion, reason),
    )
    runtime.executors["codex"] = FakeExecutor("codex")
    runtime.executors["codex"].manifest = CODEX_MANIFEST
    runtime.delegates.dispatch(
        Delegate(
            delegate_id="d-codex",
            executor="codex",
            op="run",
            request={"prompt": "inspect"},
            origin_ref="conversation:1",
            deadline=180.0,
            routing_class="user_awaited",
            dispatched_at=0.0,
        )
    )
    service, provider, assembled_runtime, _frames = make_service(
        runtime=runtime,
        telemetry=telemetry,
    )
    assert assembled_runtime is runtime
    suggestion_outlet.append(service.on_suggestion_selected)
    return service, runtime, provider


@pytest.mark.asyncio
async def test_confirmation_function_commits_while_transcript_only_records_origin() -> None:
    clock = VirtualClock()
    controller = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    controller.prepare(
        action="select",
        workspace_display_name="alpha",
        workspace_id="workspace-alpha",
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="conversation:1",
    )
    commits: list[tuple[object, str]] = []

    async def commit(operation: object, origin_ref: str) -> ProjectCommitResult:
        commits.append((operation, origin_ref))
        return ProjectCommitResult(accepted=True, code="committed")

    service, provider, runtime, _frames = make_service(
        clock=clock,
        id_factory=lambda: f"host-{next(counter)}",
        project_confirmation=controller,
        commit_project_operation=commit,
    )
    await service.connect()
    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-confirm",
            provider_item_id="user-confirm",
        )
    )
    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-confirm"))
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="response-confirm"))
    call = ToolCallReady(
        session_epoch=1,
        response_id="response-confirm",
        call_id="call-wrong",
        item_id="tool-wrong",
        name="codex__run",
        arguments={"work_order": "wrong", "origin_ref": "conversation:1"},
    )
    await service.handle_event(call)
    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="user-confirm", text="可以啊")
    )
    assert commits == []
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            response_id="response-confirm",
            call_id="confirm-1",
            item_id="function-1",
            name="codex__confirm_project_action",
            arguments={"proposal_id": "nonce", "confirmed": True},
        )
    )
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            response_id=None,
            call_id="call-late-without-response",
            item_id="tool-late",
            name="codex__run",
            arguments={"work_order": "late bypass", "origin_ref": "conversation:1"},
        )
    )
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            response_id="forged-different-response",
            call_id="call-late-forged-response",
            item_id="tool-late-forged",
            name="codex__run",
            arguments={"work_order": "forged bypass", "origin_ref": "conversation:1"},
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-confirm",
            status="cancelled",
            reason="cancelled",
        )
    )

    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    assert bridge.calls == []
    assert isinstance(runtime, FakeRuntime)
    assert [event.text for event in runtime.posted if isinstance(event, UserInput)] == ["可以啊"]
    assert len(commits) == 1
    assert commits[0][1] == "conversation:1"
    assert "cancel:response-confirm" not in provider.actions
    assert any(item.content == "已确认，已切换到工作区 alpha。" for item in provider.injected)
    blocked_outputs = {
        item.call_id
        for item in provider.injected
        if item.kind == "tool_output"
        and item.content == '{"code":"confirmation_reserved","state":"superseded"}'
    }
    assert blocked_outputs == {
        "call-wrong",
        "call-late-without-response",
        "call-late-forged-response",
    }
    confirmation_outputs = [
        item.content
        for item in provider.injected
        if item.kind == "tool_output" and item.call_id == "confirm-1"
    ]
    assert confirmation_outputs == ['{"code":"confirmed","state":"accepted"}']


@pytest.mark.asyncio
async def test_confirmation_answer_response_stays_alive_until_structured_decision() -> None:
    clock = VirtualClock()
    controller = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    controller.prepare(
        action="select",
        workspace_display_name="alpha",
        workspace_id="workspace-alpha",
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="conversation:1",
    )
    commits: list[object] = []

    async def commit(operation: object, _origin_ref: str) -> ProjectCommitResult:
        commits.append(operation)
        return ProjectCommitResult(accepted=True, code="committed")

    service, provider, _runtime, _frames = make_service(
        clock=clock,
        id_factory=lambda: f"host-{next(counter)}",
        project_confirmation=controller,
        commit_project_operation=commit,
    )
    await service.connect()
    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-answer",
            provider_item_id="user-answer",
        )
    )
    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-answer"))

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="response-answer"))
    assert "cancel:response-answer" not in provider.actions

    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="user-answer", text="同意")
    )
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            response_id="response-answer",
            call_id="confirm-answer",
            item_id="function-answer",
            name="codex__confirm_project_action",
            arguments={"proposal_id": "nonce", "confirmed": True},
        )
    )

    assert len(commits) == 1


@pytest.mark.asyncio
async def test_fenced_stale_question_cannot_consume_reserved_confirmation_answer() -> None:
    clock = VirtualClock()
    controller = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    controller.prepare(
        action="select",
        workspace_display_name="alpha",
        workspace_id="workspace-alpha",
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="conversation:1",
    )
    commits: list[object] = []

    async def commit(operation: object, _origin_ref: str) -> ProjectCommitResult:
        commits.append(operation)
        return ProjectCommitResult(accepted=True, code="committed")

    service, provider, _runtime, _frames = make_service(
        clock=clock,
        id_factory=lambda: f"host-{next(counter)}",
        project_confirmation=controller,
        commit_project_operation=commit,
    )
    await service.connect()
    service._queue_host_item(host_fact("confirmation-question-pending"), priority=50)
    await service.flush_host_items()
    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-answer",
            provider_item_id="user-answer",
        )
    )
    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-answer"))
    await service.handle_event(
        ResponseStarted(session_epoch=1, response_id="response-stale-question")
    )
    assert "cancel:response-stale-question" in provider.actions
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-stale-question",
            status="cancelled",
            reason="cancelled",
        )
    )

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="response-answer"))
    assert "cancel:response-answer" not in provider.actions
    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="user-answer", text="确认")
    )
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            response_id="response-answer",
            call_id="confirm-answer",
            item_id="function-answer",
            name="codex__confirm_project_action",
            arguments={"proposal_id": "nonce", "confirmed": True},
        )
    )

    assert len(commits) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("proposal_id", "confirmed", "expected_pending", "output_code"),
    [
        ("nonce", False, False, "cancelled"),
        ("nonce", "true", True, "confirmation_invalid"),
        ("stale", True, True, "invalid"),
    ],
)
async def test_confirmation_function_fail_closed_inputs(
    proposal_id: str,
    confirmed: object,
    expected_pending: bool,
    output_code: str,
) -> None:
    clock = VirtualClock()
    controller = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    controller.prepare(
        action="select",
        workspace_display_name="alpha",
        workspace_id="workspace-alpha",
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="conversation:1",
    )
    commits: list[object] = []

    async def commit(operation: object, _origin_ref: str) -> ProjectCommitResult:
        commits.append(operation)
        return ProjectCommitResult(accepted=True, code="committed")

    service, provider, _runtime, _frames = make_service(
        clock=clock,
        id_factory=lambda: f"host-{next(counter)}",
        project_confirmation=controller,
        commit_project_operation=commit,
    )
    await service.connect()
    await service.handle_event(
        UserSpeechStarted(session_epoch=1, speech_id="speech-1", provider_item_id="user-1")
    )
    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-1"))
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="response-1"))
    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="user-1", text="模型不能据此决定")
    )
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            response_id="response-1",
            call_id="confirm-1",
            item_id="function-1",
            name="codex__confirm_project_action",
            arguments={"proposal_id": proposal_id, "confirmed": confirmed},
        )
    )

    assert commits == []
    assert controller.pending is expected_pending
    outputs = [item for item in provider.injected if item.call_id == "confirm-1"]
    assert len(outputs) == 1
    assert json.loads(outputs[0].content)["code"] == output_code


@pytest.mark.asyncio
async def test_confirmation_function_replay_and_other_response_fail_closed() -> None:
    clock = VirtualClock()
    controller = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    controller.prepare(
        action="select",
        workspace_display_name="alpha",
        workspace_id="workspace-alpha",
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="conversation:1",
    )
    commits: list[object] = []

    async def commit(operation: object, _origin_ref: str) -> ProjectCommitResult:
        commits.append(operation)
        return ProjectCommitResult(accepted=True, code="committed")

    service, provider, _runtime, _frames = make_service(
        clock=clock,
        id_factory=lambda: f"host-{next(counter)}",
        project_confirmation=controller,
        commit_project_operation=commit,
    )
    await service.connect()
    await service.handle_event(
        UserSpeechStarted(session_epoch=1, speech_id="speech-1", provider_item_id="user-1")
    )
    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-1"))
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="response-1"))
    await service.handle_event(UserTranscriptFinal(session_epoch=1, item_id="user-1", text="确认"))
    wrong = ToolCallReady(
        session_epoch=1,
        response_id="response-other",
        call_id="confirm-other",
        item_id="function-other",
        name="codex__confirm_project_action",
        arguments={"proposal_id": "nonce", "confirmed": True},
    )
    await service.handle_event(
        replace(
            wrong,
            session_epoch=2,
            response_id="response-1",
            call_id="confirm-stale-epoch",
        )
    )
    assert commits == []
    await service.handle_event(wrong)
    assert commits == []
    call = replace(wrong, response_id="response-1", call_id="confirm-1")
    await service.handle_event(call)
    await service.handle_event(call)
    assert len(commits) == 1
    assert sum(item.call_id == "confirm-1" for item in provider.injected) == 1


@pytest.mark.asyncio
async def test_stale_response_start_cannot_bind_current_confirmation_item() -> None:
    clock = VirtualClock()
    controller = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    controller.prepare(
        action="select",
        workspace_display_name="alpha",
        workspace_id="workspace-alpha",
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="conversation:1",
    )
    commits: list[object] = []

    async def commit(operation: object, _origin_ref: str) -> ProjectCommitResult:
        commits.append(operation)
        return ProjectCommitResult(accepted=True, code="committed")

    service, provider, _runtime, _frames = make_service(
        clock=clock,
        id_factory=lambda: f"host-{next(counter)}",
        project_confirmation=controller,
        commit_project_operation=commit,
    )
    await service.connect()
    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1, speech_id="speech-current", provider_item_id="user-current"
        )
    )
    await service.handle_event(ResponseStarted(session_epoch=2, response_id="response-stale"))
    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="user-current", text="确认")
    )
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            response_id="response-stale",
            call_id="confirm-polluted",
            item_id="function-polluted",
            name="codex__confirm_project_action",
            arguments={"proposal_id": "nonce", "confirmed": True},
        )
    )

    assert commits == []
    assert controller.pending is True


class _ProposalIdEqualityImpostor:
    def __eq__(self, _other: object) -> bool:
        return True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "invalid_arguments",
    [
        {"proposal_id": "nonce", "confirmed": True, "extra": 1},
        {"proposal_id": "nonce"},
        {"proposal_id": "", "confirmed": True},
        {"proposal_id": "p" * 129, "confirmed": True},
        {"proposal_id": "nonce", "confirmed": 1},
        {"proposal_id": _ProposalIdEqualityImpostor(), "confirmed": True},
    ],
    ids=["extra", "missing", "empty", "overlong", "integer-bool", "equality-impostor"],
)
async def test_malformed_confirmation_arguments_preserve_reservation(
    invalid_arguments: dict[object, object],
) -> None:
    clock = VirtualClock()
    controller = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    controller.prepare(
        action="select",
        workspace_display_name="alpha",
        workspace_id="workspace-alpha",
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="conversation:1",
    )
    commits: list[object] = []

    async def commit(operation: object, _origin_ref: str) -> ProjectCommitResult:
        commits.append(operation)
        return ProjectCommitResult(accepted=True, code="committed")

    service, provider, _runtime, _frames = make_service(
        clock=clock,
        id_factory=lambda: f"host-{next(counter)}",
        project_confirmation=controller,
        commit_project_operation=commit,
    )
    await service.connect()
    await service.handle_event(
        UserSpeechStarted(session_epoch=1, speech_id="speech-1", provider_item_id="user-1")
    )
    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-1"))
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="response-1"))
    await service.handle_event(UserTranscriptFinal(session_epoch=1, item_id="user-1", text="确认"))
    invalid = ToolCallReady(
        session_epoch=1,
        response_id="response-1",
        call_id="confirm-invalid",
        item_id="function-invalid",
        name="codex__confirm_project_action",
        arguments=invalid_arguments,  # type: ignore[arg-type]
    )
    await service.handle_event(invalid)
    await service.handle_event(invalid)

    assert commits == []
    assert controller.pending is True
    assert sum(item.call_id == "confirm-invalid" for item in provider.injected) == 1

    await service.handle_event(
        replace(
            invalid,
            call_id="confirm-valid",
            item_id="function-valid",
            arguments={"proposal_id": "nonce", "confirmed": True},
        )
    )
    assert len(commits) == 1


@pytest.mark.asyncio
async def test_confirmation_terminal_without_function_releases_for_next_item() -> None:
    clock = VirtualClock()
    controller = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    controller.prepare(
        action="select",
        workspace_display_name="alpha",
        workspace_id="workspace-alpha",
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="conversation:1",
    )
    service, provider, _runtime, _frames = make_service(
        clock=clock,
        id_factory=lambda: f"host-{next(counter)}",
        project_confirmation=controller,
    )
    await service.connect()
    await service.handle_event(
        UserSpeechStarted(session_epoch=1, speech_id="speech-first", provider_item_id="first")
    )
    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-first"))
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="response-first"))
    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="first", text="我没说清楚")
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1, response_id="response-first", status="completed", reason="completed"
        )
    )
    assert controller.pending is True
    retry_prompt = "我没有确认清楚；若界面仍显示等待确认，请明确说“确认”或“取消”。"
    assert [
        *(item.content for item in provider.injected),
        *(queued.intent.item.content for queued in service._host_items),
    ].count(retry_prompt) == 1
    assert controller.reserve_user_item(epoch=1, item_id="second") is True


@pytest.mark.asyncio
async def test_spoken_confirmation_response_gets_no_duplicate_retry_prompt() -> None:
    clock = VirtualClock()
    controller = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    controller.prepare(
        action="select",
        workspace_display_name="alpha",
        workspace_id="workspace-alpha",
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="conversation:1",
    )
    service, provider, _runtime, _frames = make_service(
        clock=clock,
        id_factory=lambda: f"host-{next(counter)}",
        project_confirmation=controller,
    )
    await service.connect()
    await service.handle_event(
        UserSpeechStarted(session_epoch=1, speech_id="speech-spoken", provider_item_id="spoken")
    )
    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-spoken"))
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="response-spoken"))
    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="spoken", text="我还在想")
    )
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="response-spoken", pcm=b"\x00\x01")
    )
    generation = service.session.current_generation
    assert generation is not None
    assert service.playback_started(generation.utterance_id, generation.generation_epoch)
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-spoken",
            status="completed",
            reason="completed",
        )
    )

    messages = [
        *(item.content for item in provider.injected),
        *(queued.intent.item.content for queued in service._host_items),
    ]
    assert not any("我没有确认清楚" in message for message in messages)


@pytest.mark.asyncio
async def test_silent_confirmation_terminal_at_expiry_cannot_offer_retry() -> None:
    clock = VirtualClock()
    controller = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    controller.prepare(
        action="select",
        workspace_display_name="alpha",
        workspace_id="workspace-alpha",
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="conversation:1",
    )
    service, provider, _runtime, _frames = make_service(
        clock=clock,
        id_factory=lambda: f"host-{next(counter)}",
        project_confirmation=controller,
    )
    await service.connect()
    await service.handle_event(
        UserSpeechStarted(session_epoch=1, speech_id="speech-expiry", provider_item_id="expiry")
    )
    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-expiry"))
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="response-expiry"))
    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="expiry", text="我还在想")
    )
    clock.advance_to(90.0)
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-expiry",
            status="completed",
            reason="completed",
        )
    )

    messages = [
        *(item.content for item in provider.injected),
        *(queued.intent.item.content for queued in service._host_items),
    ]
    assert controller.pending is False
    assert not any("我没有确认清楚" in message for message in messages)


@pytest.mark.asyncio
async def test_expiry_removes_retry_queued_while_user_holds_floor() -> None:
    clock = VirtualClock()
    controller = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    controller.prepare(
        action="select",
        workspace_display_name="alpha",
        workspace_id="workspace-alpha",
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="conversation:1",
    )
    service, _provider, _runtime, _frames = make_service(
        clock=clock,
        id_factory=lambda: f"host-{next(counter)}",
        project_confirmation=controller,
    )
    await service.connect()
    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-near-expiry",
            provider_item_id="near-expiry",
        )
    )
    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-near-expiry"))
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="response-near-expiry"))
    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="near-expiry", text="我还在想")
    )
    clock.advance_to(89.0)
    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-holds-floor",
            provider_item_id="floor-holder",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-near-expiry",
            status="completed",
            reason="completed",
        )
    )
    assert any(
        queued.intent.item.event_id.startswith("project-confirmation-retry:")
        for queued in service._host_items
    )

    clock.advance_to(90.0)
    assert controller.expire() is True
    assert not any(
        queued.intent.item.event_id.startswith("project-confirmation-retry:")
        for queued in service._host_items
    )


@pytest.mark.asyncio
async def test_confirmation_function_may_arrive_before_user_transcript() -> None:
    clock = VirtualClock()
    controller = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    controller.prepare(
        action="select",
        workspace_display_name="alpha",
        workspace_id="workspace-alpha",
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="conversation:1",
    )
    commits: list[object] = []

    async def commit(operation: object, _origin_ref: str) -> ProjectCommitResult:
        commits.append(operation)
        return ProjectCommitResult(accepted=True, code="committed")

    service, _provider, _runtime, _frames = make_service(
        clock=clock,
        id_factory=lambda: f"host-{next(counter)}",
        project_confirmation=controller,
        commit_project_operation=commit,
    )
    await service.connect()
    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1, speech_id="speech-tool-first", provider_item_id="tool-first-user"
        )
    )
    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-tool-first"))
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-first-response"))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            response_id="tool-first-response",
            call_id="tool-first-confirm",
            item_id="tool-first-function",
            name="codex__confirm_project_action",
            arguments={"proposal_id": "nonce", "confirmed": True},
        )
    )
    assert commits == []
    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="tool-first-user", text="确认")
    )

    assert len(commits) == 1


@pytest.mark.asyncio
async def test_project_commit_failure_uses_bounded_chinese_instead_of_internal_code() -> None:
    clock = VirtualClock()
    controller = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    controller.prepare(
        action="select",
        workspace_display_name="alpha",
        workspace_id="workspace-alpha",
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="conversation:1",
    )

    async def reject(_operation: object, _origin_ref: str) -> ProjectCommitResult:
        return ProjectCommitResult(accepted=False, code="workspace_name_conflict")

    service, provider, _runtime, _frames = make_service(
        clock=clock,
        id_factory=lambda: f"host-{next(counter)}",
        project_confirmation=controller,
        commit_project_operation=reject,
    )
    await service.connect()
    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-confirm",
            provider_item_id="user-confirm",
        )
    )
    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-confirm"))
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="confirm-response"))
    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="user-confirm", text="确认")
    )
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            response_id="confirm-response",
            call_id="confirm-rejected",
            item_id="function-rejected",
            name="codex__confirm_project_action",
            arguments={"proposal_id": "nonce", "confirmed": True},
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="confirm-response",
            status="cancelled",
            reason="cancelled",
        )
    )

    messages = [item.content for item in provider.injected if item.kind == "final"]
    assert messages == ["工作区名称已存在，本次操作未执行。"]
    assert "workspace_name_conflict" not in repr(provider.injected)


@pytest.mark.asyncio
async def test_confirmation_deferred_calls_are_closed_without_touching_unrelated_entries() -> None:
    service, provider, _runtime, _frames = make_service(id_factory=lambda: f"host-{next(counter)}")
    await service.connect()
    matching = ToolCallReady(
        session_epoch=1,
        response_id="response-confirm",
        call_id="call-matching",
        item_id="tool-matching",
        name="codex__run",
        arguments={"work_order": "matching", "origin_ref": "conversation:1"},
    )
    unrelated = ToolCallReady(
        session_epoch=1,
        response_id="response-other",
        call_id="call-unrelated",
        item_id="tool-unrelated",
        name="codex__run",
        arguments={"work_order": "unrelated", "origin_ref": "conversation:1"},
    )
    service._origin_deferred_tool_calls.extend(
        (
            realtime_service._DeferredOriginToolCall(
                event=matching,
                response_id="response-confirm",
                user_item_id="user-confirm",
            ),
            realtime_service._DeferredOriginToolCall(
                event=unrelated,
                response_id="response-other",
                user_item_id="user-other",
            ),
        )
    )

    await service._close_confirmation_deferred_calls("user-confirm")

    assert [item.call_id for item in provider.injected if item.kind == "tool_output"] == [
        "call-matching"
    ]
    assert [call.event.call_id for call in service._origin_deferred_tool_calls] == [
        "call-unrelated"
    ]
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    assert bridge.calls == []


@pytest.mark.asyncio
async def test_confirmation_tool_close_is_exactly_once_under_concurrent_cleanup() -> None:
    service, provider, _runtime, _frames = make_service(id_factory=lambda: f"host-{next(counter)}")
    await service.connect()
    call = ToolCallReady(
        session_epoch=1,
        response_id="response-confirm",
        call_id="call-once",
        item_id="tool-once",
        name="codex__run",
        arguments={"work_order": "blocked", "origin_ref": "conversation:1"},
    )
    entered = asyncio.Event()
    release = asyncio.Event()
    original = provider.inject_host_item

    async def delayed(item: HostContextItem) -> ItemIdentity:
        entered.set()
        await release.wait()
        return await original(item)

    provider.inject_host_item = delayed  # type: ignore[method-assign]
    first = asyncio.create_task(service._close_project_confirmation_tool(call))
    await entered.wait()
    second = asyncio.create_task(service._close_project_confirmation_tool(call))
    await asyncio.sleep(0)
    release.set()
    await asyncio.gather(first, second)

    assert [item.call_id for item in provider.injected if item.kind == "tool_output"] == [
        "call-once"
    ]


@pytest.mark.asyncio
async def test_confirmation_close_preserves_calls_appended_during_provider_await() -> None:
    service, provider, _runtime, _frames = make_service(id_factory=lambda: f"host-{next(counter)}")
    await service.connect()

    def deferred(call_id: str, user_item_id: str) -> realtime_service._DeferredOriginToolCall:
        event = ToolCallReady(
            session_epoch=1,
            response_id=f"response-{call_id}",
            call_id=call_id,
            item_id=f"tool-{call_id}",
            name="codex__run",
            arguments={"work_order": call_id, "origin_ref": "conversation:1"},
        )
        return realtime_service._DeferredOriginToolCall(
            event=event,
            response_id=event.response_id or "",
            user_item_id=user_item_id,
        )

    service._origin_deferred_tool_calls.append(deferred("matching", "user-confirm"))
    entered = asyncio.Event()
    release = asyncio.Event()
    original = provider.inject_host_item

    async def delayed(item: HostContextItem) -> ItemIdentity:
        entered.set()
        await release.wait()
        return await original(item)

    provider.inject_host_item = delayed  # type: ignore[method-assign]
    closing = asyncio.create_task(service._close_confirmation_deferred_calls("user-confirm"))
    await entered.wait()
    service._origin_deferred_tool_calls.append(deferred("late", "user-later"))
    release.set()
    await closing

    assert [call.event.call_id for call in service._origin_deferred_tool_calls] == ["late"]


@pytest.mark.asyncio
async def test_confirmation_expiry_reconnects_fenced_epoch_before_later_tool_admission() -> None:
    clock = VirtualClock()
    controller = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    controller.prepare(
        action="select",
        workspace_display_name="alpha",
        workspace_id="workspace-alpha",
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="conversation:1",
    )
    service, provider, _runtime, _frames = make_service(
        clock=clock,
        id_factory=lambda: f"host-{next(counter)}",
        project_confirmation=controller,
    )
    await service.connect()
    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-confirm",
            provider_item_id="user-confirm",
        )
    )
    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-confirm"))
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="fenced-confirm"))

    clock.advance_to(90.0)
    assert controller.expire() is True
    for _ in range(12):
        await asyncio.sleep(0)

    assert provider.epoch == service.session.session_epoch == 2
    expiry_epochs = [
        epoch
        for item, epoch in zip(provider.injected, provider.injected_epochs, strict=True)
        if item.content == "确认已过期，本次操作已取消。"
    ]
    assert expiry_epochs == [2]
    await service.handle_event(ResponseStarted(session_epoch=2, response_id="expiry-ack"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=2,
            response_id="expiry-ack",
            status="completed",
            reason="completed",
        )
    )
    await service.handle_event(ResponseStarted(session_epoch=2, response_id="later-response"))
    stale = ToolCallReady(
        session_epoch=1,
        response_id=None,
        call_id="call-stale",
        item_id="tool-stale",
        name="codex__run",
        arguments={"work_order": "stale", "origin_ref": "conversation:1"},
    )
    fresh = ToolCallReady(
        session_epoch=2,
        response_id="later-response",
        call_id="call-1",
        item_id="tool-fresh",
        name="codex__run",
        arguments={"work_order": "fresh", "origin_ref": "conversation:1"},
    )
    await service.handle_event(stale)
    await service.handle_event(fresh)

    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    assert [call.call_id for call in bridge.calls] == ["call-1"]


@pytest.mark.asyncio
async def test_confirmation_expiry_closes_all_old_epoch_deferred_calls_before_reconnect() -> None:
    clock = VirtualClock()
    controller = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    controller.prepare(
        action="select",
        workspace_display_name="alpha",
        workspace_id="workspace-alpha",
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="conversation:1",
    )
    service, provider, _runtime, _frames = make_service(
        clock=clock,
        id_factory=lambda: f"host-{next(counter)}",
        project_confirmation=controller,
    )
    await service.connect()
    service._queue_host_item(host_fact("confirmation-question-pending"), priority=50)
    await service.flush_host_items()
    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-confirm",
            provider_item_id="user-confirm",
        )
    )
    for call_id, user_item_id in (
        ("call-matching", "user-confirm"),
        ("call-unrelated", "user-other"),
    ):
        event = ToolCallReady(
            session_epoch=1,
            response_id=f"response-{call_id}",
            call_id=call_id,
            item_id=f"tool-{call_id}",
            name="codex__run",
            arguments={"work_order": call_id, "origin_ref": "conversation:1"},
        )
        service._origin_deferred_tool_calls.append(
            realtime_service._DeferredOriginToolCall(
                event=event,
                response_id=event.response_id or "",
                user_item_id=user_item_id,
            )
        )

    clock.advance_to(90.0)
    assert controller.expire() is True
    for _ in range(20):
        await asyncio.sleep(0)

    assert provider.epoch == 2
    assert [item.call_id for item in provider.injected if item.kind == "tool_output"] == [
        "call-matching",
        "call-unrelated",
    ]
    assert not service._origin_deferred_tool_calls


@pytest.mark.asyncio
async def test_confirmation_expiry_reconnects_when_fence_is_armed_before_response_start() -> None:
    clock = VirtualClock()
    controller = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    controller.prepare(
        action="select",
        workspace_display_name="alpha",
        workspace_id="workspace-alpha",
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="conversation:1",
    )
    service, provider, _runtime, _frames = make_service(
        clock=clock,
        id_factory=lambda: f"host-{next(counter)}",
        project_confirmation=controller,
    )
    await service.connect()
    service._queue_host_item(host_fact("confirmation-question-pending"), priority=50)
    await service.flush_host_items()
    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-confirm",
            provider_item_id="user-confirm",
        )
    )

    clock.advance_to(90.0)
    assert controller.expire() is True
    for _ in range(12):
        await asyncio.sleep(0)

    assert provider.epoch == service.session.session_epoch == 2
    assert [
        epoch
        for item, epoch in zip(provider.injected, provider.injected_epochs, strict=True)
        if item.content == "确认已过期，本次操作已取消。"
    ] == [2]


@pytest.mark.asyncio
async def test_late_expired_transcript_closes_deferred_call_instead_of_dispatching() -> None:
    clock = VirtualClock()
    controller = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    controller.prepare(
        action="select",
        workspace_display_name="alpha",
        workspace_id="workspace-alpha",
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="conversation:1",
    )
    service, provider, _runtime, _frames = make_service(
        clock=clock,
        id_factory=lambda: f"host-{next(counter)}",
        project_confirmation=controller,
    )
    await service.connect()
    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-confirm",
            provider_item_id="user-confirm",
        )
    )
    deferred = ToolCallReady(
        session_epoch=1,
        response_id="response-confirm",
        call_id="call-expired",
        item_id="tool-expired",
        name="codex__run",
        arguments={"work_order": "must not run", "origin_ref": "conversation:1"},
    )
    service._origin_deferred_tool_calls.append(
        realtime_service._DeferredOriginToolCall(
            event=deferred,
            response_id="response-confirm",
            user_item_id="user-confirm",
        )
    )

    clock.advance_to(90.0)
    assert controller.expire() is True
    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="user-confirm", text="确认")
    )
    for _ in range(12):
        await asyncio.sleep(0)

    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    assert bridge.calls == []
    assert [item.call_id for item in provider.injected if item.kind == "tool_output"] == [
        "call-expired"
    ]


@pytest.mark.asyncio
async def test_confirmation_expiry_still_queues_fact_when_reconnect_fails() -> None:
    clock = VirtualClock()
    controller = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    controller.prepare(
        action="select",
        workspace_display_name="alpha",
        workspace_id="workspace-alpha",
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="conversation:1",
    )
    service, provider, _runtime, _frames = make_service(
        clock=clock,
        id_factory=lambda: f"host-{next(counter)}",
        project_confirmation=controller,
    )
    await service.connect()
    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-confirm",
            provider_item_id="user-confirm",
        )
    )

    async def fail_reconnect(*_args: object, **_kwargs: object) -> bool:
        raise RuntimeError("provider unavailable")

    service._reconnect_provider_session = fail_reconnect  # type: ignore[method-assign]
    clock.advance_to(90.0)
    assert controller.expire() is True
    for _ in range(12):
        await asyncio.sleep(0)

    assert any(item.content == "确认已过期，本次操作已取消。" for item in provider.injected)


@pytest.mark.asyncio
async def test_confirmation_expiry_hung_reconnect_is_bounded_and_still_queues_fact() -> None:
    clock = VirtualClock()
    controller = ProjectConfirmationController(clock=clock, id_factory=lambda: "nonce")
    controller.prepare(
        action="select",
        workspace_display_name="alpha",
        workspace_id="workspace-alpha",
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="conversation:1",
    )
    service, provider, _runtime, _frames = make_service(
        clock=clock,
        id_factory=lambda: f"host-{next(counter)}",
        project_confirmation=controller,
    )
    await service.connect()
    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-confirm",
            provider_item_id="user-confirm",
        )
    )
    never = asyncio.Event()

    async def hung_reconnect(*_args: object, **_kwargs: object) -> bool:
        await never.wait()
        return True

    service._reconnect_provider_session = hung_reconnect  # type: ignore[method-assign]
    clock.advance_to(90.0)
    assert controller.expire() is True
    for _ in range(4):
        await asyncio.sleep(0)
    clock.advance_to(95.0)
    for _ in range(20):
        await asyncio.sleep(0)

    assert service._project_expiry_task is None
    assert not service._project_confirmation_closing_items
    assert any(item.content == "确认已过期，本次操作已取消。" for item in provider.injected)


@pytest.mark.asyncio
async def test_overlapping_confirmation_expiries_are_drained_in_order() -> None:
    clock = VirtualClock()
    service, provider, _runtime, _frames = make_service(
        clock=clock,
        id_factory=lambda: f"host-{next(counter)}",
    )
    await service.connect()
    never = asyncio.Event()

    async def hung_reconnect(*_args: object, **_kwargs: object) -> bool:
        await never.wait()
        return True

    service._reconnect_provider_session = hung_reconnect  # type: ignore[method-assign]
    service._project_confirmation_items.add((1, "user-one"))
    service._project_confirmation_blocking = True
    service._project_confirmation_fence_pending = True
    service._project_confirmation_expired()
    for _ in range(4):
        await asyncio.sleep(0)
    service._project_confirmation_items.add((1, "user-two"))
    service._project_confirmation_blocking = True
    service._project_confirmation_fence_pending = True
    service._project_confirmation_expired()

    for _ in range(8):
        for _ in range(8):
            await asyncio.sleep(0)
        if service._project_expiry_task is None:
            break
        deadline = clock.next_timer_ts()
        if deadline is not None:
            clock.advance_to(deadline)

    assert service._project_expiry_task is None
    assert not service._project_expiry_batches
    assert not service._project_confirmation_closing_items
    delivered = sum(item.content == "确认已过期，本次操作已取消。" for item in provider.injected)
    queued = sum(
        item.intent.item.content == "确认已过期，本次操作已取消。" for item in service._host_items
    )
    assert delivered + queued == 2


counter = count(1)


def semantic_codex_progress(
    summary: str | None = "检查后确认旧版只保存在页面内存中",
    **overrides: object,
) -> ProgressEvent:
    values: dict[str, object] = {
        "channel": "codex",
        "delegate_id": "d-codex",
        "op": "run",
        "phase": "working",
        "internal_activity": 1,
        "elapsed": 2.0,
        "summary": summary,
        "ts": 1.0,
        "seq": 1,
    }
    values.update(overrides)
    return ProgressEvent(**values)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_policy_enabled_semantic_progress_updates_state_without_direct_host_item() -> None:
    service, runtime, _provider = make_policy_enabled_codex_service()
    await service.connect()
    event = semantic_codex_progress("检查后确认旧版只保存在页面内存中")

    runtime._process_event(event, reclaim=True)

    assert service.codex_state == "running"
    assert service._host_items == []
    assert runtime.suggestions.all()[0].evidence_refs == ("codex:1",)


@pytest.mark.asyncio
async def test_policy_enabled_count_only_progress_updates_state_without_direct_host_item() -> None:
    service, runtime, _provider = make_policy_enabled_codex_service()
    await service.connect()

    runtime._process_event(semantic_codex_progress(summary=None), reclaim=True)

    assert service.codex_state == "running"
    assert service._host_items == []
    assert runtime.suggestions.all() == ()
    assert runtime.memory.channels["codex"].items[-1].content["internal_activity"] == 1


@pytest.mark.asyncio
async def test_policy_enabled_external_started_keeps_acknowledgement_owned_notification() -> None:
    service, runtime, _provider = make_policy_enabled_codex_service()
    await service.connect()

    runtime._process_event(
        semantic_codex_progress(
            summary=None,
            phase="started",
            internal_activity=0,
            elapsed=0.0,
        ),
        reclaim=True,
    )

    assert service.codex_state == "running"
    assert [queued.intent.item.content for queued in service._host_items] == [
        "Codex 已开始处理这个任务。"
    ]


@pytest.mark.asyncio
async def test_policy_enabled_terminal_still_queues_one_deterministic_final_host_item() -> None:
    service, runtime, _provider = make_policy_enabled_codex_service()
    await service.connect()

    runtime._process_event(
        HandoffEvent(
            channel="codex",
            delegate_id="d-codex",
            origin_ref="conversation:1",
            outcome="ok",
            trust="trusted_system",
            content={"result": {"final_message": {"text": "完成。", "truncated": False}}},
            ts=2.0,
            seq=2,
        ),
        reclaim=True,
    )

    assert service.codex_state == "idle"
    assert [queued.intent.item.event_id for queued in service._host_items] == ["final:d-codex"]


@pytest.mark.asyncio
async def test_terminal_after_selective_progress_preserves_selected_then_final_order() -> None:
    service, runtime, _provider = make_policy_enabled_codex_service()
    await service.connect()
    runtime._process_event(semantic_codex_progress("**已完成** 自动保存并通过测试"), reclaim=True)
    suggestion = runtime.suggestions.all()[0]
    runtime._consume_watch(
        WatchRecord(
            reason=WakeReason(
                kind=ProgressEvent.KIND,
                priority=CODEX_POLICY.priority,
                routing_class="ambient",
                origin="d-codex",
            ),
            output=SurrogateOutput(
                speak=True,
                suggestion_id=suggestion.id,
                reason="值得现在播报",
            ),
            offered=(suggestion.id,),
            trigger=AttentionTrigger(
                suggestion_id=suggestion.id,
                delegate_id="d-codex",
                channel="codex",
                memory_ref="codex:1",
            ),
        )
    )

    runtime._process_event(
        HandoffEvent(
            channel="codex",
            delegate_id="d-codex",
            origin_ref="conversation:1",
            outcome="ok",
            trust="trusted_system",
            content={"result": {"final_message": {"text": "全部完成。", "truncated": False}}},
            ts=2.0,
            seq=2,
        ),
        reclaim=True,
    )

    queued = sorted(service._host_items)
    assert [item.intent.item.event_id for item in queued] == [
        f"suggestion:{suggestion.id}",
        "final:d-codex",
    ]
    assert [item.intent.item.kind for item in queued] == ["progress", "final"]
    assert queued[0].intent.item.content == "已完成 自动保存并通过测试"
    assert queued[0].priority == CODEX_POLICY.priority
    assert queued[0].preemptive is False
    assert queued[1].preemptive is False
    assert runtime.suggestions.get(suggestion.id).status == "pending"  # type: ignore[union-attr]


@pytest.mark.parametrize(
    "case",
    ("missing_ref", "two_refs", "wrong_summary", "started_evidence", "policy_disabled"),
)
@pytest.mark.asyncio
async def test_selected_summary_without_exact_progress_evidence_stays_final(case: str) -> None:
    service, runtime, _provider = make_policy_enabled_codex_service()
    await service.connect()
    runtime._process_event(
        semantic_codex_progress("已完成 parser，正在继续 aggregate"), reclaim=True
    )
    selected = runtime.suggestions.all()[0]

    if case == "missing_ref":
        candidate = replace(selected, id="s-manual", evidence_refs=())
    elif case == "two_refs":
        candidate = replace(
            selected,
            id="s-manual",
            evidence_refs=(selected.evidence_refs[0], "conversation:1"),
        )
    elif case == "wrong_summary":
        candidate = replace(selected, id="s-manual", content={"summary": "另一条进度"})
    elif case == "started_evidence":
        evidence = runtime.memory.append(
            "codex",
            ts=2.0,
            trust="trusted_system",
            priority=CODEX_POLICY.priority,
            content={"phase": "started", "summary": selected.content["summary"]},
        )
        candidate = replace(selected, id="s-manual", evidence_refs=(evidence.ref,))
    else:
        evidence = runtime.memory.append(
            CONVERSATION_CHANNEL,
            ts=2.0,
            trust="trusted_system",
            priority=USER_PRIORITY,
            content={"phase": "working", "summary": selected.content["summary"]},
        )
        candidate = replace(selected, id="s-manual", evidence_refs=(evidence.ref,))

    service.on_suggestion_selected(
        candidate,
        WakeReason(kind="suggestion_selected", priority=50, routing_class="ambient"),
    )

    assert service._host_items[-1].intent.item.kind == "final"


@pytest.mark.asyncio
async def test_failed_surrogate_never_restores_direct_progress() -> None:
    class _FailingSurrogate:
        async def watch(self, _view: object) -> SurrogateOutput:
            raise RuntimeError("surrogate failed")

    service, runtime, _provider = make_policy_enabled_codex_service()
    origin = runtime.memory.append(
        "conversation",
        ts=0.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "刚才确认了什么"},
    )
    runtime.surrogate = _FailingSurrogate()  # type: ignore[assignment]
    await service.connect()

    runtime._process_event(semantic_codex_progress(), reclaim=True)
    with pytest.raises(RuntimeError, match="surrogate failed"):
        await runtime.run()

    recalled = compile_memory_recall(
        runtime.memory,
        query="页面内存",
        scope="recent",
        before_ref=origin.ref,
    )
    assert [hit.ref for hit in recalled.hits] == ["codex:1"]
    assert service._host_items == []


@pytest.mark.asyncio
async def test_contract_invalid_surrogate_never_restores_direct_progress() -> None:
    service, runtime, _provider = make_policy_enabled_codex_service()
    origin = runtime.memory.append(
        "conversation",
        ts=0.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "刚才确认了什么"},
    )
    await service.connect()
    runtime._process_event(semantic_codex_progress(), reclaim=True)
    suggestion = runtime.suggestions.all()[0]

    runtime._consume_watch(
        WatchRecord(
            reason=WakeReason(
                kind=ProgressEvent.KIND,
                priority=CODEX_POLICY.priority,
                routing_class="ambient",
                origin="d-codex",
            ),
            output=SurrogateOutput(
                speak=True,
                suggestion_id="s-invented",
                reason="invalid_contract",
            ),
            offered=(suggestion.id,),
            trigger=AttentionTrigger(
                suggestion_id=suggestion.id,
                delegate_id="d-codex",
                channel="codex",
                memory_ref="codex:1",
            ),
        )
    )

    recalled = compile_memory_recall(
        runtime.memory,
        query="页面内存",
        scope="recent",
        before_ref=origin.ref,
    )
    assert [hit.ref for hit in recalled.hits] == ["codex:1"]
    assert service._host_items == []


@pytest.mark.asyncio
async def test_provider_schemas_survive_reconnect_without_narrowing_host_bindings() -> None:
    provider_schemas = ({"type": "function", "function": {"name": "codex__run"}},)
    service, provider, _runtime, _frames = make_service(provider_schemas=provider_schemas)
    provider_schemas[0]["function"]["name"] = "caller_mutated"

    await service.connect()
    provider.connected_tools[0][0]["function"]["name"] = "provider_mutated"
    await service._reconnect_provider_session()

    assert provider.connected_tools[1][0]["function"]["name"] == "codex__run"
    assert "codex__run" in service._tools.bindings


@pytest.mark.asyncio
async def test_public_tool_call_acceptance_snapshot_is_immutable_and_detached() -> None:
    service, _provider, _runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )

    snapshots = service.tool_call_acceptances()
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    assert snapshots[0].session_epoch == 1
    assert snapshots[0].call_id == "call-1"
    assert snapshots[0].provider_response_id == "tool-response"
    assert snapshots[0].acceptance is bridge.acceptance
    assert service.stopped is False
    with pytest.raises(FrozenInstanceError):
        snapshots[0].call_id = "mutated"  # type: ignore[misc]

    service._tool_calls.clear()
    assert len(snapshots) == 1
    assert snapshots[0].call_id == "call-1"


@pytest.mark.asyncio
@pytest.mark.parametrize("malformed_action", ([], {}))
async def test_malformed_project_action_is_refused_without_aborting_service(
    malformed_action: object,
) -> None:
    service, _provider, _runtime, _frames = make_service()
    service._tools = CompiledTools(
        schemas=(),
        bindings={
            "codex__project": ToolBinding(
                kind="delegate",
                logical_name="codex.project",
                executor="codex",
                op="project",
            )
        },
    )
    refused = HostContextItem.tool_output(
        host_item_id="host-invalid-project",
        event_id="event-invalid-project",
        call_id="call-invalid-project",
        content='{"code":"invalid_params","state":"refused"}',
    )
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    bridge.acceptance = ToolAcceptance(
        accepted=False,
        code="invalid_params",
        host_item=refused,
        response_intent=HostResponseIntent.tool_result(refused),
        executor="codex",
        op="project",
    )

    await service.connect()
    await service.handle_event(
        ResponseStarted(session_epoch=1, response_id="invalid-project-response")
    )
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            response_id="invalid-project-response",
            call_id="call-invalid-project",
            item_id="item-invalid-project",
            name="codex__project",
            arguments={"action": malformed_action},
        )
    )

    assert bridge.calls[-1].arguments == {"action": malformed_action}
    acceptance = service.tool_call_acceptances()[-1].acceptance
    assert acceptance.accepted is False
    assert acceptance.code == "invalid_params"
    assert service.stopped is False


@pytest.mark.asyncio
async def test_inline_memory_recall_uses_fulfilled_ledger_and_privacy_safe_telemetry() -> None:
    telemetry_records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            telemetry_records.append((kind, payload))

    service, provider, _runtime, _frames = make_service(telemetry=_Telemetry())
    service._tools = CompiledTools(
        schemas=(),
        bindings={"memory__recall": ToolBinding(kind="query", logical_name="memory.recall")},
    )
    host_item = HostContextItem.tool_output(
        host_item_id="host-recall",
        event_id="event-recall",
        call_id="call-recall",
        content=('{"hits":[{"evidence":"桌面上出现蓝色水杯","ref":"watch:1"}],"state":"ok"}'),
    )
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    bridge.acceptance = ToolAcceptance(
        accepted=True,
        code="ok",
        host_item=host_item,
        response_intent=HostResponseIntent.tool_result(host_item),
        inline_fulfilled=True,
        telemetry={
            "query_digest": "a" * 64,
            "scope": "recent",
            "state": "ok",
            "raw_scanned": 1,
            "searched_count": 1,
            "scan_truncated": False,
            "hit_count": 1,
            "hit_refs": ("watch:1",),
            "matches": {"lexical": 0, "recency_fallback": 1},
            "omitted": 0,
            "elapsed": 0.001,
        },
    )
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="origin-response"))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-recall",
            item_id="item-recall",
            name="memory__recall",
            arguments={"query": "刚才看到了什么", "scope": "recent"},
            response_id="origin-response",
        )
    )

    state = service._tool_calls[(1, "call-recall")]
    snapshot = service.tool_call_acceptances()[0].acceptance
    assert state.dispatch == "fulfilled"
    assert snapshot.delegate_id is None
    assert snapshot.sync_result is False
    assert service._pending_sync == {}

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="origin-response",
            status="completed",
            reason="completed",
        )
    )
    await service.handle_event(
        ResponseStarted(session_epoch=1, response_id="recall-continuation-response")
    )
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="recall-continuation-response",
            pcm=b"\x00\x01",
        )
    )
    generation = service.session.current_generation
    assert generation is not None
    assert service.playback_started(generation.utterance_id, generation.generation_epoch)

    assert provider.injected == [host_item]
    assert provider.response_intents[-1].kind == "tool_result"
    assert provider.response_intents[-1].item is host_item
    payload = next(payload for kind, payload in telemetry_records if kind == "memory.recall")
    assert set(payload) == {
        "query_digest",
        "scope",
        "state",
        "raw_scanned",
        "searched_count",
        "scan_truncated",
        "hit_count",
        "hit_refs",
        "matches",
        "omitted",
        "elapsed",
    }
    serialized = json.dumps(payload, ensure_ascii=False)
    assert "刚才看到了什么" not in serialized
    assert "桌面上出现蓝色水杯" not in serialized
    assert [payload for kind, payload in telemetry_records if kind == "playback.attribution"] == [
        {"target": "memory_recall"}
    ]


def test_attention_decision_telemetry_is_exact_and_content_free() -> None:
    telemetry_records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            telemetry_records.append((kind, payload))

    service, _provider, _runtime, _frames = make_service(telemetry=_Telemetry())

    service.on_attention_decision(
        AttentionDecision(
            channel="codex",
            memory_ref="codex:1",
            speak=True,
            selected=False,
        )
    )

    assert telemetry_records == [
        (
            "attention.decision",
            {
                "channel": "codex",
                "memory_ref": "codex:1",
                "speak": True,
                "selected": False,
            },
        )
    ]


@pytest.mark.parametrize(
    ("scenario", "logical_name", "expected_outcome"),
    (
        ("inline", "memory.recall", "inline"),
        ("sync", "codex.status", "sync"),
        ("delegated", "codex.run", "delegated"),
        ("rejected", "codex.run", "rejected"),
        ("superseded", "codex.run", "superseded"),
    ),
)
@pytest.mark.asyncio
async def test_tool_admission_telemetry_records_only_logical_name_and_bounded_outcome(
    scenario: str,
    logical_name: str,
    expected_outcome: str,
) -> None:
    telemetry_records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            telemetry_records.append((kind, payload))

    service, _provider, _runtime, _frames = make_service(telemetry=_Telemetry())
    binding = ToolBinding(
        kind="query" if scenario == "inline" else "delegate",
        logical_name=logical_name,
        executor=None if scenario == "inline" else "codex",
        op=None if scenario == "inline" else "status" if scenario == "sync" else "run",
        sync_result=scenario == "sync",
    )
    service._tools = CompiledTools(schemas=(), bindings={"provider__tool": binding})
    host_item = HostContextItem.tool_output(
        host_item_id="output-sentinel",
        event_id="event-sentinel",
        call_id="call-id-sentinel",
        content='{"secret":"output-sentinel"}',
    )
    response_intent = (
        HostResponseIntent.delegation_acknowledgement(
            item=host_item,
            task_summary="参数哨兵",
        )
        if scenario == "delegated"
        else HostResponseIntent.tool_result(host_item)
    )
    acceptance = ToolAcceptance(
        accepted=scenario not in {"rejected", "superseded"},
        code="rejected" if scenario == "rejected" else "accepted",
        delegate_id=("d-tool" if scenario in {"sync", "delegated"} else None),
        host_item=host_item,
        response_intent=response_intent,
        executor=("codex" if scenario in {"sync", "delegated"} else None),
        inline_fulfilled=scenario == "inline",
        sync_result=scenario == "sync",
    )
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    bridge.acceptance = acceptance
    await service.connect()
    await service.handle_event(
        ResponseStarted(session_epoch=1, response_id="provider-id-sentinel-active")
    )

    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-id-sentinel",
            item_id="item-id-sentinel",
            name="provider__tool",
            arguments={
                "query": "查询哨兵",
                "arguments": "参数哨兵",
                "path": "/private/路径哨兵",
            },
            response_id=(
                "provider-id-sentinel-stale"
                if scenario == "superseded"
                else "provider-id-sentinel-active"
            ),
        )
    )

    admissions = [payload for kind, payload in telemetry_records if kind == "tool.admission"]
    assert admissions == [{"logical_name": logical_name, "outcome": expected_outcome}]
    assert set(admissions[0]) == {"logical_name", "outcome"}
    serialized = json.dumps(admissions[0], ensure_ascii=False)
    for sentinel in (
        "查询哨兵",
        "参数哨兵",
        "/private/路径哨兵",
        "provider-id-sentinel",
        "call-id-sentinel",
        "output-sentinel",
    ):
        assert sentinel not in serialized


@pytest.mark.asyncio
async def test_cancelled_origin_never_downgrades_inline_recall_to_background_fact() -> None:
    service, provider, _runtime, _frames = make_service()
    service._tools = CompiledTools(
        schemas=(),
        bindings={"memory__recall": ToolBinding(kind="query", logical_name="memory.recall")},
    )
    host_item = HostContextItem.tool_output(
        host_item_id="host-recall",
        event_id="event-recall",
        call_id="call-recall",
        content='{"hits":[],"state":"empty"}',
    )
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    bridge.acceptance = ToolAcceptance(
        accepted=True,
        code="empty",
        host_item=host_item,
        response_intent=HostResponseIntent.tool_result(host_item),
        inline_fulfilled=True,
    )
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="origin-response"))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-recall",
            item_id="item-recall",
            name="memory__recall",
            arguments={"query": "刚才看到了什么", "scope": "recent"},
            response_id="origin-response",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="origin-response",
            status="cancelled",
            reason="barge_in",
        )
    )

    state = service._tool_calls[(1, "call-recall")]
    assert state.dispatch == "fulfilled"
    assert state.continuation == "abandoned"
    assert state.final_disposition == "abandoned"
    assert provider.response_intents == []
    assert service._host_items == []
    assert service._semantic_acknowledgements == {}


@pytest.mark.asyncio
async def test_tool_call_waits_for_late_same_turn_user_transcript_origin() -> None:
    """Live regression: Qwen can emit its tool call and response terminal
    before the same turn's user transcript final. Dispatch must wait for the
    host-assigned canonical MemoryRef instead of binding provider placeholder
    text or the previous user turn."""
    service, provider, runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-user",
            provider_item_id="user-item",
        )
    )
    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-user"))
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    call = ToolCallReady(
        session_epoch=1,
        call_id="call-late-origin",
        item_id="item-tool",
        name="codex__run",
        arguments={"work_order": "运行测试", "origin_ref": "user_request_001"},
        response_id="tool-response",
    )
    await service.handle_event(call)
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="completed",
            reason="completed",
        )
    )

    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    assert bridge.calls == []
    assert service.tool_call_acceptances() == ()
    assert provider.injected == []

    await service.handle_event(
        UserTranscriptFinal(
            session_epoch=1,
            item_id="user-item",
            text="请运行完整测试并报告",
        )
    )

    assert bridge.calls == [call]
    assert runtime.posted == [UserInput(text="请运行完整测试并报告")]
    assert service.tool_call_acceptances()[0].call_id == "call-late-origin"
    assert provider.injected == [bridge.acceptance.host_item]


@pytest.mark.asyncio
async def test_transcript_failure_releases_keyed_deferred_tool_call_without_origin_ref() -> None:
    """A failed keyed ASR item releases its deferred tool without a fabricated Memory ref."""
    service, _provider, runtime, _frames = make_service()
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    await service.connect()
    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-user",
            provider_item_id="user-item",
        )
    )
    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-user"))
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    call = ToolCallReady(
        session_epoch=1,
        call_id="call-late-origin",
        item_id="tool-item",
        name="codex__run",
        arguments={"work_order": "运行测试"},
        response_id="tool-response",
    )
    await service.handle_event(call)

    assert len(service._origin_deferred_tool_calls) == 1
    await service.handle_event(UserTranscriptFailed(session_epoch=1, item_id="user-item"))

    assert bridge.calls == [call]
    assert bridge.origin_refs == [None]
    assert not service._origin_deferred_tool_calls
    assert runtime.posted == []


@pytest.mark.asyncio
async def test_transcript_failure_before_keyed_tool_call_dispatches_without_origin_ref() -> None:
    """A failed bound item cannot leave a later same-response tool call deferred forever."""
    service, _provider, runtime, _frames = make_service()
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    await service.connect()
    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-user",
            provider_item_id="user-item",
        )
    )
    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-user"))
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.handle_event(UserTranscriptFailed(session_epoch=1, item_id="user-item"))
    call = ToolCallReady(
        session_epoch=1,
        call_id="call-after-failure",
        item_id="tool-item",
        name="codex__run",
        arguments={"work_order": "运行测试"},
        response_id="tool-response",
    )
    await service.handle_event(call)

    assert bridge.calls == [call]
    assert bridge.origin_refs == [None]
    assert not service._origin_deferred_tool_calls
    assert runtime.posted == []


@pytest.mark.asyncio
async def test_older_asr_failure_cannot_rebind_tool_to_newer_transcript() -> None:
    """A failed older turn keeps its active response outside a newer origin wait."""
    service, _provider, runtime, _frames = make_service()
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    await service.connect()

    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-first",
            provider_item_id="user-first",
        )
    )
    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-first"))
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="response-first"))
    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-second",
            provider_item_id="user-second",
        )
    )
    await service.handle_event(UserTranscriptFailed(session_epoch=1, item_id="user-first"))

    first_call = ToolCallReady(
        session_epoch=1,
        call_id="call-first",
        item_id="tool-first",
        name="codex__run",
        arguments={"work_order": "执行第一个任务"},
        response_id="response-first",
    )
    await service.handle_event(first_call)

    assert bridge.calls == [first_call]
    assert bridge.origin_refs == [None]
    assert not service._origin_deferred_tool_calls

    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="user-second", text="执行第二个任务")
    )

    assert bridge.calls == [first_call]
    assert bridge.origin_refs == [None]
    assert not service._origin_deferred_tool_calls
    assert runtime.posted == [UserInput(text="执行第二个任务")]

    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-second"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-first",
            status="completed",
            reason="completed",
        )
    )
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="response-host"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-host",
            status="completed",
            reason="completed",
        )
    )
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="response-second"))

    assert not service._unbound_user_origin_items
    assert service._user_origin_preexisting_response_id is None


@pytest.mark.asyncio
async def test_transcript_failure_releases_one_unkeyed_response_batch() -> None:
    """One unknown ASR item releases only the oldest anonymous deferred response batch."""
    service, _provider, runtime, _frames = make_service()
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    await service.connect()
    await service.handle_event(UserSpeechStarted(session_epoch=1, speech_id="speech-user"))
    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-user"))
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="response-first"))
    first = ToolCallReady(
        session_epoch=1,
        call_id="call-first",
        item_id="tool-first",
        name="codex__run",
        arguments={"work_order": "运行测试"},
        response_id="response-first",
    )
    await service.handle_event(first)
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-first",
            status="completed",
            reason="completed",
        )
    )
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="response-second"))
    second = ToolCallReady(
        session_epoch=1,
        call_id="call-second",
        item_id="tool-second",
        name="codex__run",
        arguments={"work_order": "运行第二个测试"},
        response_id="response-second",
    )
    await service.handle_event(second)

    assert len(service._origin_deferred_tool_calls) == 2
    await service.handle_event(UserTranscriptFailed(session_epoch=1, item_id="failed-item"))

    assert bridge.calls == [first]
    assert bridge.origin_refs == [None]
    assert [deferred.event for deferred in service._origin_deferred_tool_calls] == [second]
    assert runtime.posted == []


@pytest.mark.asyncio
async def test_duplicate_transcript_terminal_does_not_dispatch_tool_twice() -> None:
    """A later completed frame for a failed ASR item cannot dispatch its deferred tool again."""
    service, _provider, runtime, _frames = make_service()
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    await service.connect()
    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-user",
            provider_item_id="user-item",
        )
    )
    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-user"))
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    call = ToolCallReady(
        session_epoch=1,
        call_id="call-late-origin",
        item_id="tool-item",
        name="codex__run",
        arguments={"work_order": "运行测试"},
        response_id="tool-response",
    )
    await service.handle_event(call)
    failed = UserTranscriptFailed(session_epoch=1, item_id="user-item")
    await service.handle_event(failed)
    await service.handle_event(failed)
    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="user-item", text="fabricated")
    )

    assert bridge.calls == [call]
    assert bridge.origin_refs == [None]
    assert not service._origin_deferred_tool_calls
    assert runtime.posted == []


@pytest.mark.asyncio
async def test_overlapping_late_transcripts_release_only_their_own_tool_call() -> None:
    """Review regression: consecutive Qwen turns can both finish their tool
    response before either transcript final arrives. The first transcript must
    not authorize the later turn's call."""
    first = acceptance_for(
        "call-first",
        event_id="event-first",
        delegate_id="delegate-first",
        summary="第一个任务",
    )
    second = acceptance_for(
        "call-second",
        event_id="event-second",
        delegate_id="delegate-second",
        summary="第二个任务",
    )
    service, _provider, _runtime, _frames = make_service()
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    bridge.acceptance = {"call-first": first, "call-second": second}
    await service.connect()

    calls: list[ToolCallReady] = []
    for suffix in ("first", "second"):
        await service.handle_event(
            UserSpeechStarted(
                session_epoch=1,
                speech_id=f"speech-{suffix}",
                provider_item_id=f"user-{suffix}",
            )
        )
        await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id=f"speech-{suffix}"))
        await service.handle_event(
            ResponseStarted(session_epoch=1, response_id=f"response-{suffix}")
        )
        call = ToolCallReady(
            session_epoch=1,
            call_id=f"call-{suffix}",
            item_id=f"tool-{suffix}",
            name="codex__run",
            arguments={"work_order": f"任务 {suffix}", "origin_ref": "provider-placeholder"},
            response_id=f"response-{suffix}",
        )
        calls.append(call)
        await service.handle_event(call)
        await service.handle_event(
            ResponseTerminal(
                session_epoch=1,
                response_id=f"response-{suffix}",
                status="completed",
                reason="completed",
            )
        )

    assert bridge.calls == []

    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="user-first", text="先做第一个任务")
    )
    assert bridge.calls == [calls[0]]
    assert bridge.origin_refs == ["conversation:1"]

    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="user-second", text="再做第二个任务")
    )
    assert bridge.calls == calls
    assert bridge.origin_refs == ["conversation:1", "conversation:2"]


@pytest.mark.asyncio
async def test_transcript_before_response_keeps_exact_origin_after_newer_transcript() -> None:
    """Review regression: a completed transcript stays bindable until its
    provider response starts; a later transcript must not replace its ref."""
    service, _provider, _runtime, _frames = make_service()
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    await service.connect()

    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-first",
            provider_item_id="user-first",
        )
    )
    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-first"))
    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="user-first", text="先做第一个任务")
    )
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="response-first"))

    await service.handle_event(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-second",
            provider_item_id="user-second",
        )
    )
    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-second"))
    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="user-second", text="第二个任务先别做")
    )

    call = ToolCallReady(
        session_epoch=1,
        call_id="call-first",
        item_id="tool-first",
        name="codex__run",
        arguments={"work_order": "执行第一个任务", "origin_ref": "provider-placeholder"},
        response_id="response-first",
    )
    await service.handle_event(call)

    assert bridge.calls == [call]
    assert bridge.origin_refs == ["conversation:1"]


@pytest.mark.asyncio
async def test_unkeyed_late_transcripts_release_one_response_batch_in_turn_order() -> None:
    """Review regression: providers may omit speech item IDs; one transcript
    then releases only the oldest anonymous response batch, not every later turn."""
    first = acceptance_for(
        "call-first",
        event_id="event-first",
        delegate_id="delegate-first",
        summary="第一个任务",
    )
    second = acceptance_for(
        "call-second",
        event_id="event-second",
        delegate_id="delegate-second",
        summary="第二个任务",
    )
    service, _provider, _runtime, _frames = make_service()
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    bridge.acceptance = {"call-first": first, "call-second": second}
    await service.connect()

    calls: list[ToolCallReady] = []
    for suffix in ("first", "second"):
        await service.handle_event(UserSpeechStarted(session_epoch=1, speech_id=f"speech-{suffix}"))
        await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id=f"speech-{suffix}"))
        await service.handle_event(
            ResponseStarted(session_epoch=1, response_id=f"response-{suffix}")
        )
        call = ToolCallReady(
            session_epoch=1,
            call_id=f"call-{suffix}",
            item_id=f"tool-{suffix}",
            name="codex__run",
            arguments={"work_order": f"任务 {suffix}", "origin_ref": "provider-placeholder"},
            response_id=f"response-{suffix}",
        )
        calls.append(call)
        await service.handle_event(call)
        await service.handle_event(
            ResponseTerminal(
                session_epoch=1,
                response_id=f"response-{suffix}",
                status="completed",
                reason="completed",
            )
        )

    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="transcript-first", text="第一个任务")
    )
    assert bridge.calls == [calls[0]]
    assert bridge.origin_refs == ["conversation:1"]

    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="transcript-second", text="第二个任务")
    )
    assert bridge.calls == calls
    assert bridge.origin_refs == ["conversation:1", "conversation:2"]


@pytest.mark.asyncio
async def test_reconnect_stops_release_of_remaining_deferred_origin_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Review regression: once a deferred call forces an epoch change, the
    release snapshot must not dispatch any remaining old-epoch calls."""
    service, _provider, _runtime, _frames = make_service()
    await service.connect()
    deferred = tuple(
        realtime_service._DeferredOriginToolCall(
            event=ToolCallReady(
                session_epoch=1,
                call_id=f"call-{index}",
                item_id=f"tool-{index}",
                name="codex__run",
                arguments={"work_order": f"任务 {index}"},
                response_id=f"response-{index}",
            ),
            response_id=f"response-{index}",
            user_item_id="user-item",
        )
        for index in (1, 2)
    )
    service._origin_deferred_tool_calls.extend(deferred)
    handled: list[str] = []

    async def reconnect_on_first(
        event: ToolCallReady,
        *,
        observed_provider_response_id: str | None = None,
        origin_ref: str | None = None,
    ) -> None:
        del observed_provider_response_id, origin_ref
        handled.append(event.call_id)
        if len(handled) == 1:
            await service._reconnect_provider_session()

    monkeypatch.setattr(service, "_handle_tool_call", reconnect_on_first)

    await service._release_deferred_origin_calls("user-item", "conversation:1")

    assert service.session.session_epoch == 2
    assert handled == ["call-1"]


def test_public_semantic_acknowledgement_lookup_requires_bound_background_event() -> None:
    service, _provider, _runtime, _frames = make_service()
    service._semantic_acknowledgements["other:d-2"] = _SemanticAcknowledgement(
        event_id="other:d-2",
        summary="不是后台确认",
        phase="bound",
        response_id="response-ack",
        binding="continuation",
    )
    service._semantic_acknowledgements["background:d-1"] = _SemanticAcknowledgement(
        event_id="background:d-1",
        summary="实现俄罗斯方块",
        phase="bound",
        response_id="response-ack",
        binding="continuation",
    )

    assert service.semantic_acknowledgement_for("response-ack") == "d-1"
    assert service.semantic_acknowledgement_for("missing") is None


def project_claimed_handoff(
    service: RealtimeService,
    runtime: FakeRuntime,
    event: HandoffEvent,
    *,
    op: str = "start",
) -> None:
    runtime.delegates.authorize_handoff(event, op=op)
    service.project_runtime_event(event)


def test_successful_monitor_stop_closure_keeps_state_but_queues_no_duplicate_final() -> None:
    service, _provider, runtime, _frames = make_service(executor_names=("guard",))
    stop = HandoffEvent(
        channel="guard",
        delegate_id="d-stop",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={"stopped": True},
    )
    start = HandoffEvent(
        channel="guard",
        delegate_id="d-start",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={"state": "stopped", "hit": False},
    )

    project_claimed_handoff(service, runtime, stop, op="stop")
    project_claimed_handoff(service, runtime, start, op="start")

    assert service.session.delegate_state("d-stop") == "completed"
    assert service.session.delegate_state("d-start") == "completed"
    assert service._host_items == []


def test_failed_monitor_stop_still_queues_a_user_visible_final() -> None:
    service, _provider, runtime, _frames = make_service(executor_names=("guard",))
    event = HandoffEvent(
        channel="guard",
        delegate_id="d-stop",
        origin_ref="conversation:1",
        outcome="failed",
        trust="trusted_system",
        content={"error": "stop failed"},
    )

    project_claimed_handoff(service, runtime, event, op="stop")

    assert [queued.intent.item.event_id for queued in service._host_items] == ["final:d-stop"]


async def complete_audible_response(
    service: RealtimeService,
    response_id: str,
    *,
    session_epoch: int = 1,
) -> None:
    await service.handle_event(
        ResponseStarted(session_epoch=session_epoch, response_id=response_id)
    )
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=session_epoch,
            response_id=response_id,
            pcm=b"\x00\x01",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=session_epoch,
            response_id=response_id,
            status="completed",
            reason="completed",
        )
    )
    generation = service.session.current_generation
    assert generation is not None
    assert service.playback_done(generation.utterance_id, generation.generation_epoch)


async def start_audible_response(service: RealtimeService, response_id: str) -> None:
    await service.handle_event(ResponseStarted(session_epoch=1, response_id=response_id))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id=response_id, pcm=b"\x00\x01")
    )


async def prepare_origin_delegation(service: RealtimeService) -> PlaybackGeneration:
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="tool-response", pcm=b"\x00\x01")
    )
    generation = service.session.current_generation
    assert generation is not None
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="completed",
            reason="completed",
        )
    )
    return generation


def delegation_acceptance_for(
    call_id: str,
    *,
    event_id: str,
    delegate_id: str,
    summary: str,
) -> ToolAcceptance:
    item = HostContextItem.tool_output(
        host_item_id=f"host-{call_id}",
        event_id=event_id,
        call_id=call_id,
        content='{"state":"accepted"}',
    )
    return ToolAcceptance(
        accepted=True,
        code="accepted",
        delegate_id=delegate_id,
        host_item=item,
        response_intent=HostResponseIntent.delegation_acknowledgement(
            item=item,
            task_summary=summary,
        ),
        executor="codex",
    )


async def prepare_suggestion_response(
    *,
    clock: VirtualClock | None = None,
    telemetry: object | None = None,
    controlled_guard_reconnect: bool = False,
) -> tuple[
    RealtimeService,
    FakeProvider,
    Runtime,
    Suggestion,
]:
    runtime = Runtime(clock=VirtualClock() if clock is None else clock, memory=Memory())
    service, provider, assembled_runtime, _frames = make_service(
        runtime=runtime,
        telemetry=telemetry,
        controlled_guard_reconnect=controlled_guard_reconnect,
    )
    assert assembled_runtime is runtime
    await service.connect()
    suggestion = runtime.suggestions.add(
        origin="executor",
        kind="notify",
        content={"observation": "桌面上出现水杯", "private_key": "never speak this"},
        evidence_refs=("watch:1",),
        salience=40.0,
    )
    service.on_suggestion_selected(
        suggestion,
        WakeReason(kind="suggestion_selected", priority=40, routing_class="ambient"),
    )
    await service.flush_host_items()
    assert provider.injected[-1].event_id == f"suggestion:{suggestion.id}"
    assert provider.injected[-1].content == "桌面上出现水杯"
    assert runtime.suggestions.get(suggestion.id).status == "pending"
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="suggestion-response"))
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="suggestion-response",
            pcm=b"\x00\x01",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="suggestion-response",
            status="completed",
            reason="completed",
        )
    )
    return service, provider, runtime, suggestion


@pytest.mark.asyncio
async def test_ordinary_suggestion_playback_does_not_record_progress_attribution() -> None:
    telemetry_records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            telemetry_records.append((kind, payload))

    service, _provider, _runtime, _suggestion = await prepare_suggestion_response(
        telemetry=_Telemetry()
    )
    generation = service.session.current_generation
    assert generation is not None

    assert service.playback_started(generation.utterance_id, generation.generation_epoch)

    assert [payload for kind, payload in telemetry_records if kind == "playback.attribution"] == []


@pytest.mark.asyncio
async def test_canonical_codex_progress_playback_records_only_target_and_memory_ref() -> None:
    telemetry_records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            telemetry_records.append((kind, payload))

    service, runtime, provider = make_policy_enabled_codex_service(telemetry=_Telemetry())
    await service.connect()
    runtime._process_event(semantic_codex_progress("确认自动保存已通过测试"), reclaim=True)
    suggestion = runtime.suggestions.all()[0]
    service.on_suggestion_selected(
        suggestion,
        WakeReason(kind="suggestion_selected", priority=50, routing_class="ambient"),
    )
    await service.flush_host_items()
    assert provider.injected[-1].event_id == f"suggestion:{suggestion.id}"
    await service.handle_event(
        ResponseStarted(session_epoch=1, response_id="progress-suggestion-response")
    )
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="progress-suggestion-response",
            pcm=b"\x00\x01",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="progress-suggestion-response",
            status="completed",
            reason="completed",
        )
    )
    generation = service.session.current_generation
    assert generation is not None

    assert service.playback_started(generation.utterance_id, generation.generation_epoch)
    assert [payload for kind, payload in telemetry_records if kind == "playback.attribution"] == [
        {"target": "selected_progress", "memory_ref": "codex:1"}
    ]


@pytest.mark.asyncio
async def test_policy_enabled_non_codex_progress_playback_is_attributed() -> None:
    telemetry_records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            telemetry_records.append((kind, payload))

    policy = HandoffPolicy(
        channel="sensor",
        priority=40,
        wake="none",
        typical_latency=1.0,
        compress_watermark=20,
        suggest=True,
        progress_via_surrogate=True,
    )
    memory = Memory(policies=(policy,))
    evidence = memory.append(
        "sensor",
        ts=1.0,
        trust="trusted_system",
        priority=40,
        content={"phase": "working", "summary": "传感器标定已完成"},
    )
    runtime = Runtime(clock=VirtualClock(), memory=memory)
    service, provider, assembled_runtime, _frames = make_service(
        runtime=runtime,
        telemetry=_Telemetry(),
    )
    assert assembled_runtime is runtime
    await service.connect()
    suggestion = runtime.suggestions.add(
        origin="surrogate",
        kind="notify",
        content={"summary": "传感器标定已完成"},
        evidence_refs=(evidence.ref,),
        salience=40.0,
    )
    service.on_suggestion_selected(
        suggestion,
        WakeReason(kind="suggestion_selected", priority=40, routing_class="ambient"),
    )
    await service.flush_host_items()
    assert provider.injected[-1].kind == "progress"
    await service.handle_event(
        ResponseStarted(session_epoch=1, response_id="sensor-suggestion-response")
    )
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="sensor-suggestion-response",
            pcm=b"\x00\x01",
        )
    )
    generation = service.session.current_generation
    assert generation is not None

    assert service.playback_started(generation.utterance_id, generation.generation_epoch)
    assert [payload for kind, payload in telemetry_records if kind == "playback.attribution"] == [
        {"target": "selected_progress", "memory_ref": "sensor:1"}
    ]


@pytest.mark.asyncio
async def test_noncanonical_codex_suggestion_playback_has_no_progress_attribution() -> None:
    telemetry_records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            telemetry_records.append((kind, payload))

    service, runtime, provider = make_policy_enabled_codex_service(telemetry=_Telemetry())
    await service.connect()
    runtime._process_event(semantic_codex_progress("确认自动保存已通过测试"), reclaim=True)
    suggestion = runtime.suggestions.add(
        origin="surrogate",
        kind="notify",
        content={"summary": "与 canonical evidence 不一致"},
        evidence_refs=("codex:1",),
        salience=50.0,
    )
    service.on_suggestion_selected(
        suggestion,
        WakeReason(kind="suggestion_selected", priority=50, routing_class="ambient"),
    )
    await service.flush_host_items()
    assert provider.injected[-1].event_id == f"suggestion:{suggestion.id}"
    await service.handle_event(
        ResponseStarted(session_epoch=1, response_id="noncanonical-suggestion-response")
    )
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="noncanonical-suggestion-response",
            pcm=b"\x00\x01",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="noncanonical-suggestion-response",
            status="completed",
            reason="completed",
        )
    )
    generation = service.session.current_generation
    assert generation is not None

    assert service.playback_started(generation.utterance_id, generation.generation_epoch)
    assert [payload for kind, payload in telemetry_records if kind == "playback.attribution"] == []


def make_full_chain_watch_service(
    *, routing_class: str
) -> tuple[RealtimeService, FakeProvider, Runtime]:
    policy = HandoffPolicy(
        channel="watch",
        priority=40,
        wake="none",
        typical_latency=1.0,
        compress_watermark=20,
        suggest=True,
    )
    outlet: list[Callable[[Suggestion, WakeReason], None]] = []
    runtime = Runtime(
        clock=VirtualClock(),
        memory=Memory(policies=(policy,)),
        on_suggestion_selected=lambda suggestion, reason: outlet[0](suggestion, reason),
    )
    runtime.executors["watch"] = FakeExecutor(
        "watch", ops=(WATCH_START,), priority=40, suggest=True
    )
    runtime.delegates.dispatch(
        Delegate(
            delegate_id="d-watch",
            executor="watch",
            op="start",
            request={"condition": "出现水杯"},
            origin_ref="conversation:1",
            deadline=30.0,
            routing_class=routing_class,  # type: ignore[arg-type]
            dispatched_at=0.0,
        )
    )
    service, provider, assembled_runtime, _frames = make_service(runtime=runtime)
    assert assembled_runtime is runtime
    outlet.append(service.on_suggestion_selected)
    return service, provider, runtime


def watch_handoff(*, delegate_id: str = "d-watch") -> HandoffEvent:
    return HandoffEvent(
        channel="watch",
        delegate_id=delegate_id,
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={"observation": "桌面上出现水杯"},
    )


def watch_observation(*, seq: int, hit_count: int) -> ObservationEvent:
    return ObservationEvent(
        channel="watch",
        delegate_id="d-watch",
        op="start",
        origin_ref="conversation:1",
        trust="untrusted_external",
        content={
            "state": "hit",
            "hit": True,
            "condition": "出现水杯",
            "observation": f"第 {hit_count} 次出现水杯",
            "hit_count": hit_count,
        },
        seq=seq,
    )


@pytest.mark.asyncio
async def test_repeat_watch_hits_stay_on_surrogate_route_and_supersede_silent_pending() -> None:
    service, _provider, runtime = make_full_chain_watch_service(routing_class="ambient")
    await service.connect()

    runtime._process_event(watch_observation(seq=11, hit_count=1), reclaim=True)
    first = runtime.suggestions.all()[0]
    assert service._host_items == []
    runtime._consume_watch(
        WatchRecord(
            reason=WakeReason(
                kind="observation",
                priority=40,
                routing_class="ambient",
                origin="d-watch",
            ),
            output=SurrogateOutput(speak=False, suggestion_id=None, reason="not useful"),
            offered=(first.id,),
        )
    )

    runtime._process_event(watch_observation(seq=19, hit_count=2), reclaim=True)

    first_after, second = runtime.suggestions.all()
    assert first_after.status == "withdrawn"
    offered = tuple(
        item.ref
        for item in runtime.compile_view(trigger_kind="observation").affordances
        if item.source == "suggestion"
    )
    assert offered == (second.id,)
    runtime._consume_watch(
        WatchRecord(
            reason=WakeReason(
                kind="observation",
                priority=40,
                routing_class="ambient",
                origin="d-watch",
            ),
            output=SurrogateOutput(
                speak=True,
                suggestion_id=second.id,
                reason="worth mentioning",
            ),
            offered=offered,
        )
    )

    assert [queued.intent.item.event_id for queued in service._host_items] == [
        f"suggestion:{second.id}"
    ]
    assert service._host_items[0].priority == 55
    assert service._host_items[0].preemptive is False
    assert runtime.delegates.in_flight_delegate("d-watch") is not None


@pytest.mark.asyncio
async def test_ambient_suggestion_handoff_is_silent_before_selection() -> None:
    service, provider, runtime = make_full_chain_watch_service(routing_class="ambient")
    await service.connect()

    runtime._process_event(watch_handoff(), reclaim=True)

    assert len(runtime.suggestions.all()) == 1
    assert service._host_items == []
    assert provider.response_intents == []


@pytest.mark.asyncio
async def test_duplicate_ambient_handoff_cannot_fall_through_to_direct_speech() -> None:
    service, provider, runtime = make_full_chain_watch_service(routing_class="ambient")
    await service.connect()
    event = watch_handoff()

    runtime._process_event(event, reclaim=True)
    runtime._process_event(event, reclaim=True)

    assert len(runtime.suggestions.all()) == 1
    assert service._host_items == []
    assert provider.response_intents == []


@pytest.mark.asyncio
async def test_stale_success_on_suggest_channel_cannot_speak_directly() -> None:
    service, provider, runtime = make_full_chain_watch_service(routing_class="ambient")
    await service.connect()

    runtime._process_event(watch_handoff(delegate_id="d-stale"), reclaim=True)

    assert runtime.suggestions.all() == ()
    assert service._host_items == []
    assert provider.response_intents == []


@pytest.mark.asyncio
async def test_ambient_selection_speaks_exactly_once_through_suggestion_route() -> None:
    service, provider, runtime = make_full_chain_watch_service(routing_class="ambient")
    await service.connect()
    runtime._process_event(watch_handoff(), reclaim=True)
    suggestion = runtime.suggestions.all()[0]

    runtime._consume_watch(
        WatchRecord(
            reason=WakeReason(
                kind="handoff",
                priority=40,
                routing_class="ambient",
                origin="d-watch",
            ),
            output=SurrogateOutput(
                speak=True,
                suggestion_id=suggestion.id,
                reason="worth mentioning",
            ),
            offered=(suggestion.id,),
        )
    )

    assert [queued.intent.item.event_id for queued in service._host_items] == [
        f"suggestion:{suggestion.id}"
    ]
    await service.flush_host_items()
    await complete_audible_response(service, "suggestion-response")

    assert provider.actions.count("create_response") == 1
    assert sum(action.startswith("spoken:") for action in provider.actions) == 1
    assert runtime.suggestions.get(suggestion.id).status == "fired"


@pytest.mark.asyncio
async def test_user_awaited_handoff_speaks_exactly_once_through_direct_route() -> None:
    service, provider, runtime = make_full_chain_watch_service(routing_class="user_awaited")
    await service.connect()

    runtime._process_event(watch_handoff(), reclaim=True)

    assert runtime.suggestions.all() == ()
    assert [queued.intent.item.event_id for queued in service._host_items] == ["final:d-watch"]
    await service.flush_host_items()
    await complete_audible_response(service, "direct-response")

    assert provider.actions.count("create_response") == 1
    assert sum(action.startswith("spoken:") for action in provider.actions) == 1


@pytest.mark.asyncio
async def test_watch_hit_outranks_codex_priority_without_preempting() -> None:
    service, _provider, runtime = make_full_chain_watch_service(routing_class="user_awaited")
    await service.connect()

    runtime._process_event(
        HandoffEvent(
            channel="watch",
            delegate_id="d-watch",
            origin_ref="conversation:1",
            outcome="ok",
            trust="trusted_system",
            content={"hit": True, "condition": "水杯", "observation": "桌面上出现水杯"},
        ),
        reclaim=True,
    )

    assert [queued.intent.item.event_id for queued in service._host_items] == ["final:d-watch"]
    queued = service._host_items[0]
    assert queued.priority == realtime_service.HIT_ALERT_MIN_PRIORITY == 55
    assert queued.preemptive is False


@pytest.mark.asyncio
async def test_watch_hit_flushes_before_earlier_codex_priority_item() -> None:
    service, _provider, runtime = make_full_chain_watch_service(routing_class="user_awaited")
    await service.connect()
    service._queue_host_item(
        HostResponseIntent.host_fact(
            HostContextItem.final(
                host_item_id="codex-item",
                event_id="final:d-codex",
                content="Codex 完成了任务。",
            )
        ),
        priority=50,
    )

    runtime._process_event(
        HandoffEvent(
            channel="watch",
            delegate_id="d-watch",
            origin_ref="conversation:1",
            outcome="ok",
            trust="trusted_system",
            content={"hit": True, "condition": "水杯", "observation": "桌面上出现水杯"},
        ),
        reclaim=True,
    )

    ordered = sorted(service._host_items, key=lambda queued: queued.sort_key)
    assert [queued.intent.item.event_id for queued in ordered] == [
        "final:d-watch",
        "final:d-codex",
    ]


@pytest.mark.asyncio
async def test_watch_miss_keeps_manifest_priority() -> None:
    service, _provider, runtime = make_full_chain_watch_service(routing_class="user_awaited")
    await service.connect()

    runtime._process_event(watch_handoff(), reclaim=True)

    queued = service._host_items[0]
    assert queued.priority == 40
    assert queued.preemptive is False


@pytest.mark.asyncio
async def test_watch_hit_stays_fifo_behind_older_equal_priority_item() -> None:
    """R113 invariant survives the #50 boost: at equal priority the hit keeps
    FIFO order — no preemptive tiebreak jump."""
    service, _provider, runtime = make_full_chain_watch_service(routing_class="user_awaited")
    await service.connect()
    service._queue_host_item(host_fact("earlier-alert"), priority=55)

    runtime._process_event(
        HandoffEvent(
            channel="watch",
            delegate_id="d-watch",
            origin_ref="conversation:1",
            outcome="ok",
            trust="trusted_system",
            content={"hit": True, "observation": "桌面上出现水杯"},
        ),
        reclaim=True,
    )

    ordered = sorted(service._host_items, key=lambda queued: queued.sort_key)
    assert [queued.intent.item.event_id for queued in ordered] == [
        "earlier-alert",
        "final:d-watch",
    ]


@pytest.mark.asyncio
async def test_watch_hit_waits_out_active_speech_without_cancel() -> None:
    service, provider, runtime = make_full_chain_watch_service(routing_class="user_awaited")
    await service.connect()
    service._queue_host_item(host_fact("current-speech"), priority=50)
    await service.flush_host_items()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="speech-response"))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="speech-response", pcm=b"\x00\x01")
    )
    generation = service.session.current_generation
    assert generation is not None
    assert service.playback_started(generation.utterance_id, generation.generation_epoch)

    runtime._process_event(
        HandoffEvent(
            channel="watch",
            delegate_id="d-watch",
            origin_ref="conversation:1",
            outcome="ok",
            trust="trusted_system",
            content={"hit": True, "observation": "桌面上出现水杯"},
        ),
        reclaim=True,
    )
    await service.flush_host_items()

    assert not any(action.startswith("cancel:") for action in provider.actions)
    assert service._pending_preempt_priority is None
    assert [item.event_id for item in provider.injected] == ["current-speech"]
    assert [queued.intent.item.event_id for queued in service._host_items] == ["final:d-watch"]


def test_suggestion_callback_boosts_hit_content_to_alert_band() -> None:
    """#51/R128: a Surrogate-selected hit inherits R127's alert band at the
    projection layer; the runtime wake priority itself is never escalated."""
    runtime = Runtime(clock=VirtualClock(), memory=Memory())
    service, _provider, _runtime, _frames = make_service(runtime=runtime)
    suggestion = runtime.suggestions.add(
        origin="executor",
        kind="notify",
        content={"hit": True, "condition": "水杯", "observation": "桌面上出现水杯"},
    )

    service.on_suggestion_selected(
        suggestion,
        WakeReason(kind="suggestion_selected", priority=37, routing_class="ambient"),
    )

    queued = service._host_items[0]
    assert queued.priority == realtime_service.HIT_ALERT_MIN_PRIORITY == 55
    assert queued.preemptive is False

    higher = runtime.suggestions.add(
        origin="executor",
        kind="notify",
        content={"hit": True, "condition": "水杯", "observation": "又一次出现水杯"},
    )
    service.on_suggestion_selected(
        higher,
        WakeReason(kind="suggestion_selected", priority=70, routing_class="ambient"),
    )
    priorities = {item.intent.item.event_id: item.priority for item in service._host_items}
    assert priorities[f"suggestion:{higher.id}"] == 70


def test_ambient_miss_neither_rearms_fired_alert_nor_wakes_surrogate() -> None:
    """#51 review P1: a fired alert must not be re-armed by a later explicit
    miss, and the miss itself must not wake the Surrogate — otherwise a
    window_elapsed observation can replay a stale alert."""
    policy = HandoffPolicy(
        channel="watch",
        priority=40,
        wake="surrogate",
        typical_latency=1.0,
        compress_watermark=20,
        suggest=True,
    )
    runtime = Runtime(clock=VirtualClock(), memory=Memory(policies=(policy,)))
    runtime.executors["watch"] = FakeExecutor(
        "watch", ops=(WATCH_START,), priority=40, suggest=True
    )
    for delegate_id in ("d-first", "d-second"):
        runtime.delegates.dispatch(
            Delegate(
                delegate_id=delegate_id,
                executor="watch",
                op="start",
                request={"condition": "出现水杯"},
                origin_ref="conversation:1",
                deadline=3000.0,
                routing_class="ambient",
                dispatched_at=0.0,
            )
        )
    runtime._process_event(
        HandoffEvent(
            channel="watch",
            delegate_id="d-first",
            origin_ref="conversation:1",
            outcome="ok",
            trust="trusted_system",
            content={"hit": True, "observation": "桌面上出现水杯"},
        ),
        reclaim=True,
    )
    (fired,) = runtime.suggestions.all()
    runtime.confirm_suggestion_spoken(fired.id)
    assert runtime.suggestions.get(fired.id).status == "fired"

    miss = HandoffEvent(
        channel="watch",
        delegate_id="d-second",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={"hit": False, "reason": "window_elapsed"},
        ts=runtime.suggestions.get(fired.id).cooldown_until + 1.0,
    )
    assert _wake_handoff(miss, runtime.memory, runtime.delegates) == ()

    runtime._process_event(miss, reclaim=True)

    assert runtime.suggestions.get(fired.id).status == "fired"
    assert len(runtime.suggestions.all()) == 1


@pytest.mark.asyncio
async def test_ambient_miss_handoff_never_enters_suggestion_pool() -> None:
    """#51/R128: an explicit hit=False terminal (window elapsed / stopped) is a
    non-event — pooling it forever would pollute every later Surrogate view and,
    if selected, speak a contextless notification."""
    service, provider, runtime = make_full_chain_watch_service(routing_class="ambient")
    await service.connect()

    runtime._process_event(
        HandoffEvent(
            channel="watch",
            delegate_id="d-watch",
            origin_ref="conversation:1",
            outcome="ok",
            trust="trusted_system",
            content={"hit": False, "reason": "window_elapsed"},
        ),
        reclaim=True,
    )

    assert runtime.suggestions.all() == ()
    assert service._host_items == []
    assert provider.response_intents == []


class _PendingWatchExecutor:
    manifest = ExecutorManifest(
        name="watch",
        ops=(WATCH_START,),
        policy=HandoffPolicy(
            channel="watch",
            priority=40,
            wake="none",
            typical_latency=1.0,
            compress_watermark=20,
            suggest=True,
        ),
    )

    async def dispatch(self, op: str, request: dict[str, object], ctx: object) -> None:
        del op, request, ctx
        await asyncio.Event().wait()


@pytest.mark.asyncio
async def test_real_bridge_watch_start_feeds_pool_without_direct_broadcast() -> None:
    """#51/R128 end-to-end: a real watch__start dispatch derives ambient in the
    bridge, so its hit lands in the Suggestion Pool and the service direct
    route stays silent."""
    executor = _PendingWatchExecutor()
    runtime = Runtime(
        clock=VirtualClock(),
        memory=Memory(policies=(executor.manifest.policy,)),
    )
    runtime.executors["watch"] = executor  # type: ignore[assignment]
    runtime.memory.append(
        CONVERSATION_CHANNEL,
        ts=0.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "顺便留意画面里的水杯"},
    )
    service, provider, _runtime, _frames = make_service(runtime=runtime)
    await service.connect()
    bridge = RealtimeRuntimeBridge(
        runtime=runtime,
        tools=compile_tool_schema((executor.manifest,)),
        id_factory=iter(("host-1", "event-1")).__next__,
    )

    acceptance = await bridge.accept_tool_call(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="watch__start",
            arguments={"condition": "出现水杯", "origin_ref": "conversation:1"},
        )
    )
    assert acceptance.accepted is True
    assert acceptance.delegate_id is not None

    runtime._process_event(
        HandoffEvent(
            channel="watch",
            delegate_id=acceptance.delegate_id,
            origin_ref="conversation:1",
            outcome="ok",
            trust="trusted_system",
            content={"hit": True, "observation": "桌面上出现水杯"},
        ),
        reclaim=True,
    )

    assert len(runtime.suggestions.all()) == 1
    assert service._host_items == []
    assert provider.response_intents == []


def test_suggestion_callback_queues_bounded_prose_without_envelope() -> None:
    runtime = Runtime(clock=VirtualClock(), memory=Memory())
    service, _provider, _runtime, _frames = make_service(runtime=runtime)
    suggestion = runtime.suggestions.add(
        origin="executor",
        kind="notify",
        content={"observation": "水杯" * 1000, "private_key": "never speak this"},
    )

    service.on_suggestion_selected(
        suggestion,
        WakeReason(kind="suggestion_selected", priority=37, routing_class="ambient"),
    )

    assert len(service._host_items) == 1
    queued = service._host_items[0]
    assert queued.intent.item.event_id == f"suggestion:{suggestion.id}"
    assert queued.intent.item.kind == "final"
    assert queued.intent.item.content.startswith("水杯")
    assert len(queued.intent.item.content) <= realtime_service.SPEECH_FINAL_LIMIT
    assert "observation" not in queued.intent.item.content
    assert "private_key" not in queued.intent.item.content
    assert "never speak this" not in queued.intent.item.content
    assert queued.priority == 37
    assert queued.preemptive is False


@pytest.mark.asyncio
async def test_suggestion_fires_only_after_accepted_playback_done(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, provider, runtime, suggestion = await prepare_suggestion_response()
    generation = service.session.current_generation
    assert generation is not None
    confirmations: list[str] = []
    confirm = runtime.confirm_suggestion_spoken

    def record_confirmation(suggestion_id: str) -> None:
        confirmations.append(suggestion_id)
        confirm(suggestion_id)

    monkeypatch.setattr(runtime, "confirm_suggestion_spoken", record_confirmation)

    def unexpected_snapshot() -> object:
        raise AssertionError("playback delivery must not copy the complete session snapshot")

    monkeypatch.setattr(service.session, "snapshot", unexpected_snapshot)

    assert service.session.response_event_ids(generation.response_id) == (
        f"suggestion:{suggestion.id}",
    )
    assert service.playback_done(generation.utterance_id, generation.generation_epoch)
    assert runtime.suggestions.get(suggestion.id).status == "fired"
    assert confirmations == [suggestion.id]
    assert service.session.response_event_ids(generation.response_id) == ()
    assert provider.actions[-1] == "delivery:spoken:"

    assert not service.playback_done(generation.utterance_id, generation.generation_epoch)
    assert confirmations == [suggestion.id]


@pytest.mark.asyncio
async def test_interrupted_suggestion_natural_drain_stays_retryable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = Runtime(clock=VirtualClock(), memory=Memory())
    service, _provider, assembled_runtime, _frames = make_service(runtime=runtime)
    assert assembled_runtime is runtime
    await service.connect()
    suggestion = runtime.suggestions.add(
        origin="executor",
        kind="notify",
        content={"observation": "桌面上出现水杯"},
        evidence_refs=("watch:1",),
        salience=40.0,
    )
    event_id = f"suggestion:{suggestion.id}"
    confirmations: list[str] = []
    confirm = runtime.confirm_suggestion_spoken

    def record_confirmation(suggestion_id: str) -> None:
        confirmations.append(suggestion_id)
        confirm(suggestion_id)

    monkeypatch.setattr(runtime, "confirm_suggestion_spoken", record_confirmation)
    service.on_suggestion_selected(
        suggestion,
        WakeReason(kind="suggestion_selected", priority=40, routing_class="ambient"),
    )
    await service.flush_host_items()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="suggestion-response"))
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="suggestion-response",
            pcm=b"\x00\x01",
        )
    )
    generation = service.session.current_generation
    assert generation is not None

    assert await service.session.host_preempt()
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="suggestion-response",
            status="cancelled",
            reason="client_cancelled",
        )
    )
    assert service.playback_done(generation.utterance_id, generation.generation_epoch)

    assert service.session.snapshot().spoken_event_ids == ()
    assert not service.session.host_event_is_deduplicated(event_id)
    assert runtime.suggestions.get(suggestion.id).status == "pending"
    assert confirmations == []


@pytest.mark.asyncio
async def test_suggestion_fires_not_on_wrong_generation_receipt() -> None:
    service, _provider, runtime, suggestion = await prepare_suggestion_response()
    generation = service.session.current_generation
    assert generation is not None

    assert not service.playback_done(
        generation.utterance_id,
        generation.generation_epoch + 1,
    )
    assert runtime.suggestions.get(suggestion.id).status == "pending"


@pytest.mark.asyncio
async def test_suggestion_fires_not_on_playback_cleared() -> None:
    service, _provider, runtime, suggestion = await prepare_suggestion_response()
    generation = service.session.current_generation
    assert generation is not None
    await service.local_speech_onset("barge-in")

    assert service.playback_cleared(generation.utterance_id, generation.generation_epoch)
    assert runtime.suggestions.get(suggestion.id).status == "pending"
    assert not service.playback_done(generation.utterance_id, generation.generation_epoch)
    assert runtime.suggestions.get(suggestion.id).status == "pending"


@pytest.mark.asyncio
async def test_suggestion_fires_not_on_playback_stopped() -> None:
    service, _provider, runtime, suggestion = await prepare_suggestion_response()
    generation = service.session.current_generation
    assert generation is not None

    assert await service.playback_stopped(
        generation.utterance_id,
        generation.generation_epoch,
    )
    assert runtime.suggestions.get(suggestion.id).status == "pending"
    assert not service.playback_done(generation.utterance_id, generation.generation_epoch)
    assert runtime.suggestions.get(suggestion.id).status == "pending"


async def retry_interrupted_suggestion(
    service: RealtimeService,
    provider: FakeProvider,
    runtime: Runtime,
    suggestion: Suggestion,
    *,
    response_id: str,
) -> None:
    service.on_suggestion_selected(
        suggestion,
        WakeReason(kind="suggestion_selected", priority=40, routing_class="ambient"),
    )
    await service.flush_host_items()
    assert provider.actions.count("create_response") == 2
    await complete_audible_response(service, response_id)
    assert runtime.suggestions.get(suggestion.id).status == "fired"


@pytest.mark.asyncio
async def test_cleared_suggestion_attempt_can_retry_and_confirm_exactly_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, provider, runtime, suggestion = await prepare_suggestion_response()
    generation = service.session.current_generation
    assert generation is not None
    confirmations: list[str] = []
    confirm = runtime.confirm_suggestion_spoken

    def record_confirmation(suggestion_id: str) -> None:
        confirmations.append(suggestion_id)
        confirm(suggestion_id)

    monkeypatch.setattr(runtime, "confirm_suggestion_spoken", record_confirmation)
    await service.local_speech_onset("barge-in")
    assert service.playback_cleared(generation.utterance_id, generation.generation_epoch)
    assert runtime.suggestions.get(suggestion.id).status == "pending"

    await retry_interrupted_suggestion(
        service,
        provider,
        runtime,
        suggestion,
        response_id="clear-retry",
    )

    assert confirmations == [suggestion.id]
    assert sum(item.event_id == f"suggestion:{suggestion.id}" for item in provider.injected) == 1

    await service.session.reconnect(tools=())

    event_id = f"suggestion:{suggestion.id}"
    assert service.session._injected_event_epochs[event_id] == 1
    assert service.session.host_event_is_deduplicated(event_id)


@pytest.mark.asyncio
async def test_stopped_suggestion_attempt_can_retry_and_confirm_exactly_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, provider, runtime, suggestion = await prepare_suggestion_response()
    generation = service.session.current_generation
    assert generation is not None
    confirmations: list[str] = []
    confirm = runtime.confirm_suggestion_spoken

    def record_confirmation(suggestion_id: str) -> None:
        confirmations.append(suggestion_id)
        confirm(suggestion_id)

    monkeypatch.setattr(runtime, "confirm_suggestion_spoken", record_confirmation)
    assert await service.playback_stopped(
        generation.utterance_id,
        generation.generation_epoch,
    )
    assert runtime.suggestions.get(suggestion.id).status == "pending"

    await retry_interrupted_suggestion(
        service,
        provider,
        runtime,
        suggestion,
        response_id="stop-retry",
    )

    assert confirmations == [suggestion.id]
    assert sum(item.event_id == f"suggestion:{suggestion.id}" for item in provider.injected) == 1


@pytest.mark.asyncio
async def test_prestart_fenced_suggestion_can_retry_and_confirm_exactly_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = Runtime(clock=VirtualClock(), memory=Memory())
    service, provider, assembled_runtime, _frames = make_service(runtime=runtime)
    assert assembled_runtime is runtime
    await service.connect()
    suggestion = runtime.suggestions.add(
        origin="executor",
        kind="notify",
        content={"observation": "桌面上出现水杯"},
        evidence_refs=("watch:1",),
        salience=40.0,
    )
    confirmations: list[str] = []
    confirm = runtime.confirm_suggestion_spoken

    def record_confirmation(suggestion_id: str) -> None:
        confirmations.append(suggestion_id)
        confirm(suggestion_id)

    monkeypatch.setattr(runtime, "confirm_suggestion_spoken", record_confirmation)
    service.on_suggestion_selected(
        suggestion,
        WakeReason(kind="suggestion_selected", priority=40, routing_class="ambient"),
    )
    await service.flush_host_items()
    await service.local_speech_onset("prestart-fence")
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="fenced-response"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="fenced-response",
            status="cancelled",
            reason="host_preempted",
        )
    )
    assert runtime.suggestions.get(suggestion.id).status == "pending"

    await retry_interrupted_suggestion(
        service,
        provider,
        runtime,
        suggestion,
        response_id="prestart-retry",
    )

    assert confirmations == [suggestion.id]
    assert sum(item.event_id == f"suggestion:{suggestion.id}" for item in provider.injected) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "interruption",
    [
        "cancelled_terminal_no_audio",
        "accepted_clear",
        "accepted_stop",
        "prestart_fence_terminal",
    ],
)
async def test_reconnect_retries_suggestion_after_completed_interruption_lifecycle(
    interruption: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = Runtime(clock=VirtualClock(), memory=Memory())
    service, provider, assembled_runtime, _frames = make_service(runtime=runtime)
    assert assembled_runtime is runtime
    await service.connect()
    suggestion = runtime.suggestions.add(
        origin="executor",
        kind="notify",
        content={"observation": "桌面上出现水杯"},
        evidence_refs=("watch:1",),
        salience=40.0,
    )
    confirmations: list[str] = []
    confirm = runtime.confirm_suggestion_spoken

    def record_confirmation(suggestion_id: str) -> None:
        confirmations.append(suggestion_id)
        confirm(suggestion_id)

    monkeypatch.setattr(runtime, "confirm_suggestion_spoken", record_confirmation)
    service.on_suggestion_selected(
        suggestion,
        WakeReason(kind="suggestion_selected", priority=40, routing_class="ambient"),
    )
    await service.flush_host_items()
    event_id = f"suggestion:{suggestion.id}"

    if interruption == "cancelled_terminal_no_audio":
        await service.handle_event(
            ResponseStarted(session_epoch=1, response_id="interrupted-response")
        )
        await service.local_speech_onset("barge-in")
        await service.handle_event(
            ResponseTerminal(
                session_epoch=1,
                response_id="interrupted-response",
                status="cancelled",
                reason="host_preempted",
            )
        )
        assert service.session.provider_turn_phase("interrupted-response") == "cancelled"
    elif interruption == "prestart_fence_terminal":
        await service.local_speech_onset("prestart-fence")
        await service.handle_event(
            ResponseStarted(session_epoch=1, response_id="interrupted-response")
        )
        await service.handle_event(
            ResponseTerminal(
                session_epoch=1,
                response_id="interrupted-response",
                status="cancelled",
                reason="host_preempted",
            )
        )
        assert service.session.provider_turn_phase("interrupted-response") == "cancelled"
    else:
        await service.handle_event(
            ResponseStarted(session_epoch=1, response_id="interrupted-response")
        )
        await service.handle_event(
            ResponseAudioDelta(
                session_epoch=1,
                response_id="interrupted-response",
                pcm=b"\x00\x01",
            )
        )
        await service.handle_event(
            ResponseTerminal(
                session_epoch=1,
                response_id="interrupted-response",
                status="completed",
                reason="completed",
            )
        )
        generation = service.session.current_generation
        assert generation is not None
        if interruption == "accepted_clear":
            await service.local_speech_onset("barge-in")
            assert service.playback_cleared(
                generation.utterance_id,
                generation.generation_epoch,
            )
        else:
            assert interruption == "accepted_stop"
            assert await service.playback_stopped(
                generation.utterance_id,
                generation.generation_epoch,
            )

    assert service.session.active_provider_response_id is None
    assert service.session.current_generation is None
    assert not service.session.host_event_is_deduplicated(event_id)
    assert service.session._injected_event_epochs[event_id] == 1
    assert provider.response_epochs == [1]
    assert confirmations == []

    await service.session.reconnect(tools=())

    assert provider.epoch == 2
    assert event_id not in service.session._injected_event_epochs
    service.on_suggestion_selected(
        suggestion,
        WakeReason(kind="suggestion_selected", priority=40, routing_class="ambient"),
    )
    await service.flush_host_items()
    assert provider.response_epochs == [1, 2]
    assert [
        epoch
        for item, epoch in zip(provider.injected, provider.injected_epochs, strict=True)
        if item.event_id == event_id
    ] == [1, 2]

    await complete_audible_response(
        service,
        "retry-response",
        session_epoch=2,
    )
    generation = service.session.current_generation
    assert generation is None
    assert confirmations == [suggestion.id]
    assert runtime.suggestions.get(suggestion.id).status == "fired"
    assert provider.response_epochs.count(2) == 1
    assert service.session._injected_event_epochs[event_id] == 2

    await service.session.reconnect(tools=())

    assert provider.epoch == 3
    assert service.session._injected_event_epochs[event_id] == 2
    assert service.session.host_event_is_deduplicated(event_id)
    before = (len(provider.injected), len(provider.response_intents))
    service.on_suggestion_selected(
        suggestion,
        WakeReason(kind="suggestion_selected", priority=40, routing_class="ambient"),
    )
    await service.flush_host_items()
    assert (len(provider.injected), len(provider.response_intents)) == before
    assert confirmations == [suggestion.id]


@pytest.mark.asyncio
async def test_replayed_cancelled_terminal_cannot_revoke_spoken_suggestion_authority(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = Runtime(clock=VirtualClock(), memory=Memory())
    service, provider, assembled_runtime, _frames = make_service(runtime=runtime)
    assert assembled_runtime is runtime
    await service.connect()
    suggestion = runtime.suggestions.add(
        origin="executor",
        kind="notify",
        content={"observation": "桌面上出现水杯"},
        evidence_refs=("watch:1",),
        salience=40.0,
    )
    event_id = f"suggestion:{suggestion.id}"
    confirmations: list[str] = []
    confirm = runtime.confirm_suggestion_spoken

    def record_confirmation(suggestion_id: str) -> None:
        confirmations.append(suggestion_id)
        confirm(suggestion_id)

    monkeypatch.setattr(runtime, "confirm_suggestion_spoken", record_confirmation)
    service.on_suggestion_selected(
        suggestion,
        WakeReason(kind="suggestion_selected", priority=40, routing_class="ambient"),
    )
    await service.flush_host_items()
    assert await service.session.accept(
        ResponseStarted(session_epoch=1, response_id="interrupted-response")
    )
    await service.local_speech_onset("barge-in")
    old_terminal = ResponseTerminal(
        session_epoch=1,
        response_id="interrupted-response",
        status="cancelled",
        reason="host_preempted",
    )

    assert await service.session.accept(old_terminal)
    assert service.session.response_event_ids("interrupted-response") == ()
    assert not service.session.host_event_is_deduplicated(event_id)
    assert service.session._injected_event_epochs[event_id] == 1
    assert service.session._retained_suggestion_injection_ids == {event_id}

    service.on_suggestion_selected(
        suggestion,
        WakeReason(kind="suggestion_selected", priority=40, routing_class="ambient"),
    )
    await service.flush_host_items()
    assert provider.response_epochs == [1, 1]
    await complete_audible_response(service, "retry-response")
    assert confirmations == [suggestion.id]
    assert service.session.host_event_is_deduplicated(event_id)
    assert service.session._injected_event_epochs[event_id] == 1
    assert service.session._retained_suggestion_injection_ids == set()
    before_duplicate = (
        service.session.floor,
        service.session.snapshot(),
        service.session.response_event_ids("interrupted-response"),
        tuple(provider.actions),
    )

    assert not await service.session.accept(old_terminal)

    assert service.session.host_event_is_deduplicated(event_id)
    assert service.session._injected_event_epochs[event_id] == 1
    assert service.session._retained_suggestion_injection_ids == set()
    assert (
        service.session.floor,
        service.session.snapshot(),
        service.session.response_event_ids("interrupted-response"),
        tuple(provider.actions),
    ) == before_duplicate

    await service.session.reconnect(tools=())

    assert service.session.host_event_is_deduplicated(event_id)
    assert service.session._injected_event_epochs[event_id] == 1
    before_callback = (len(provider.injected), len(provider.response_intents))
    service.on_suggestion_selected(
        suggestion,
        WakeReason(kind="suggestion_selected", priority=40, routing_class="ambient"),
    )
    await service.flush_host_items()
    assert (len(provider.injected), len(provider.response_intents)) == before_callback
    assert confirmations == [suggestion.id]


def host_fact(event_id: str) -> HostResponseIntent:
    return HostResponseIntent.host_fact(
        HostContextItem.progress(
            host_item_id=f"host-{event_id}",
            event_id=event_id,
            content=event_id,
        )
    )


def guard_handoff(
    delegate_id: str,
    *,
    outcome: str = "ok",
    hit: bool = True,
) -> HandoffEvent:
    return HandoffEvent(
        channel="guard",
        delegate_id=delegate_id,
        origin_ref="conversation:1",
        outcome=outcome,
        trust="trusted_system",
        content={
            "hit": hit,
            "condition": "出现水杯",
            "observation": "桌面上出现蓝色水杯",
        },
    )


def make_real_guard_service(
    *delegate_ids: str,
) -> tuple[RealtimeService, FakeProvider, Runtime, list[PlaybackFrame]]:
    policy = HandoffPolicy(
        channel="guard",
        priority=90,
        wake="none",
        typical_latency=1.0,
        compress_watermark=20,
    )
    runtime = Runtime(clock=VirtualClock(), memory=Memory(policies=(policy,)))
    runtime.executors["guard"] = FakeExecutor("guard", priority=90)
    for delegate_id in delegate_ids:
        runtime.delegates.dispatch(
            Delegate(
                delegate_id=delegate_id,
                executor="guard",
                op="start",
                request={"condition": "出现水杯"},
                origin_ref="conversation:1",
                deadline=30.0,
                routing_class="user_awaited",
                dispatched_at=0.0,
            )
        )
    service, provider, resolved_runtime, frames = make_service(runtime=runtime)
    assert resolved_runtime is runtime
    return service, provider, runtime, frames


@pytest.mark.asyncio
async def test_guard_hit_can_preempt_an_active_watch_announcement() -> None:
    policies = (
        HandoffPolicy(
            channel="watch",
            priority=40,
            wake="none",
            typical_latency=1.0,
            compress_watermark=20,
            suggest=True,
        ),
        HandoffPolicy(
            channel="guard",
            priority=90,
            wake="none",
            typical_latency=1.0,
            compress_watermark=20,
        ),
    )
    runtime = Runtime(clock=VirtualClock(), memory=Memory(policies=policies))
    runtime.executors.update(
        {
            "watch": FakeExecutor("watch", priority=40, suggest=True),
            "guard": FakeExecutor("guard", priority=90),
        }
    )
    for delegate_id, executor in (("d-watch", "watch"), ("d-guard", "guard")):
        runtime.delegates.dispatch(
            Delegate(
                delegate_id=delegate_id,
                executor=executor,
                op="start",
                request={"condition": "出现水杯"},
                origin_ref="conversation:1",
                deadline=30.0,
                routing_class="user_awaited",
                dispatched_at=0.0,
            )
        )
    service, provider, _resolved_runtime, _frames = make_service(runtime=runtime)
    await service.connect()
    watch = HandoffEvent(
        channel="watch",
        delegate_id="d-watch",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={
            "hit": True,
            "condition": "出现水杯",
            "observation": "桌面上出现水杯",
        },
    )

    runtime._process_event(watch, reclaim=True)
    await service.flush_host_items()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="watch-response"))
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="watch-response",
            pcm=b"\x00\x01",
        )
    )
    generation = service.session.current_generation
    assert generation is not None
    assert service.playback_started(generation.utterance_id, generation.generation_epoch)

    runtime._process_event(guard_handoff("d-guard"), reclaim=True)
    await service.flush_host_items()

    assert service._urgent_host_response_owner is None
    assert "cancel:watch-response" in provider.actions
    assert [item.event_id for item in provider.injected] == ["final:d-watch"]
    assert [item.intent.item.event_id for item in service._host_items] == ["final:d-guard"]

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="watch-response",
            status="cancelled",
            reason="guard_alert",
        )
    )
    assert service.session.current_generation == generation
    assert [item.event_id for item in provider.injected] == ["final:d-watch", "final:d-guard"]
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="guard-response"))
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="guard-response",
            pcm=b"\x02\x03",
        )
    )
    assert service.playback_cleared(generation.utterance_id, generation.generation_epoch)

    assert [item.event_id for item in provider.injected] == ["final:d-watch", "final:d-guard"]


@pytest.mark.asyncio
async def test_second_valid_guard_hit_waits_for_first_urgent_announcement() -> None:
    service, provider, runtime, _frames = make_real_guard_service("d-first", "d-second")
    await service.connect()
    runtime._process_event(guard_handoff("d-first"), reclaim=True)
    await service.flush_host_items()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="urgent-first"))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="urgent-first", pcm=b"\x00\x01")
    )
    generation = service.session.current_generation
    assert generation is not None
    assert service.playback_started(generation.utterance_id, generation.generation_epoch)

    runtime._process_event(guard_handoff("d-second"), reclaim=True)
    await service.flush_host_items()

    assert "cancel:urgent-first" not in provider.actions
    assert [item.event_id for item in provider.injected] == ["final:d-first"]
    assert [item.intent.item.event_id for item in service._host_items] == ["final:d-second"]

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="urgent-first",
            status="completed",
            reason="completed",
        )
    )
    assert service.playback_done(generation.utterance_id, generation.generation_epoch)
    assert service._urgent_host_response_owner is None
    await service.flush_host_items()

    assert [item.event_id for item in provider.injected] == ["final:d-first", "final:d-second"]


@pytest.mark.asyncio
async def test_second_guard_hit_does_not_fence_first_urgent_before_response_start() -> None:
    service, provider, runtime, _frames = make_real_guard_service("d-first", "d-second")
    await service.connect()
    runtime._process_event(guard_handoff("d-first"), reclaim=True)
    await service.flush_host_items()

    runtime._process_event(guard_handoff("d-second"), reclaim=True)
    await service.flush_host_items()

    assert not any(action.startswith("cancel:") for action in provider.actions)
    assert [item.event_id for item in provider.injected] == ["final:d-first"]
    assert [queued.intent.item.event_id for queued in service._host_items] == ["final:d-second"]

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="urgent-first"))
    assert "cancel:urgent-first" not in provider.actions


@pytest.mark.asyncio
async def test_fenced_prestart_urgent_retires_before_later_assistant_preemption() -> None:
    service, provider, runtime, _frames = make_real_guard_service("d-first", "d-second")
    await service.connect()
    runtime._process_event(guard_handoff("d-first"), reclaim=True)
    await service.flush_host_items()
    assert service._urgent_host_response_owner is not None

    await service.local_speech_onset("barge-in")

    assert service._urgent_host_response_owner is None
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="dropped-urgent",
            status="cancelled",
            reason="provider_dropped",
        )
    )
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="ordinary"))
    runtime._process_event(guard_handoff("d-second"), reclaim=True)
    await service.flush_host_items()

    assert "cancel:ordinary" in provider.actions


@pytest.mark.asyncio
async def test_pre_map_audio_cannot_bind_urgent_owner_before_accepted_start() -> None:
    service, _provider, runtime, _frames = make_real_guard_service("d-first")
    await service.connect()
    runtime._process_event(guard_handoff("d-first"), reclaim=True)
    await service.flush_host_items()

    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="urgent-first", pcm=b"\x00\x01")
    )

    owner = service._urgent_host_response_owner
    assert owner is not None
    assert owner.response_id is None
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="urgent-first"))
    assert service._urgent_host_response_owner is not None
    assert service._urgent_host_response_owner.response_id == "urgent-first"


@pytest.mark.asyncio
async def test_unrelated_terminal_cannot_release_active_urgent_response() -> None:
    service, provider, runtime, _frames = make_real_guard_service("d-first", "d-second")
    await service.connect()
    runtime._process_event(guard_handoff("d-first"), reclaim=True)
    await service.flush_host_items()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="urgent-first"))

    runtime._process_event(guard_handoff("d-second"), reclaim=True)
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="unrelated"))
    assert service.session.provider_turn_was_fenced("unrelated")

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="unrelated",
            status="cancelled",
            reason="superseded",
        )
    )

    assert service._urgent_host_response_owner is not None
    assert service._urgent_host_response_owner.response_id == "urgent-first"
    assert "cancel:urgent-first" not in provider.actions
    assert [item.event_id for item in provider.injected] == ["final:d-first"]
    assert [queued.intent.item.event_id for queued in service._host_items] == ["final:d-second"]


@pytest.mark.asyncio
async def test_urgent_preempting_prestart_ordinary_keeps_owner_and_serialization() -> None:
    service, provider, runtime, _frames = make_real_guard_service("d-first", "d-second")
    await service.connect()
    await service.session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="ordinary-item",
            event_id="progress:ordinary",
            content="ordinary fact",
        )
    )
    creates_before = provider.actions.count("create_response")

    runtime._process_event(guard_handoff("d-first"), reclaim=True)
    await service.flush_host_items()

    # The fenced ordinary pending still owns the inference slot: no second create.
    assert provider.actions.count("create_response") == creates_before
    assert service._urgent_host_response_owner is None

    # The doomed ordinary response becomes observable and is cancelled, but it
    # keeps the provider slot until its matching terminal.
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="ordinary-1"))
    assert provider.actions[-1] == "cancel:ordinary-1"
    assert provider.actions.count("create_response") == creates_before
    assert [item.event_id for item in provider.injected] == ["progress:ordinary"]
    assert service._urgent_host_response_owner is None

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="ordinary-1",
            status="cancelled",
            reason="client_cancelled",
        )
    )
    assert provider.actions.count("create_response") == creates_before + 1
    assert [item.event_id for item in provider.injected][-1] == "final:d-first"
    assert service._urgent_host_response_owner is not None

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="urgent-1"))
    assert service.session.response_event_ids("urgent-1") == ("final:d-first",)
    assert "final:d-first" not in service.session.snapshot().interrupted_event_ids

    runtime._process_event(guard_handoff("d-second"), reclaim=True)
    await service.flush_host_items()

    assert "cancel:urgent-1" not in provider.actions
    assert [item.event_id for item in provider.injected].count("final:d-first") == 1
    assert service._urgent_host_response_owner is not None


@pytest.mark.asyncio
async def test_rejected_unknown_terminal_cannot_release_bound_urgent_owner() -> None:
    service, _provider, runtime, _frames = make_real_guard_service("d-first")
    await service.connect()
    runtime._process_event(guard_handoff("d-first"), reclaim=True)
    await service.flush_host_items()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="urgent-1"))
    assert service._urgent_host_response_owner is not None
    assert service._urgent_host_response_owner.response_id == "urgent-1"

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="never-started",
            status="cancelled",
            reason="replayed",
        )
    )

    assert service._urgent_host_response_owner is not None
    assert service._urgent_host_response_owner.response_id == "urgent-1"


@pytest.mark.asyncio
async def test_rejected_unknown_terminal_cannot_release_unbound_urgent_owner() -> None:
    service, _provider, runtime, _frames = make_real_guard_service("d-first")
    await service.connect()
    runtime._process_event(guard_handoff("d-first"), reclaim=True)
    await service.flush_host_items()
    owner = service._urgent_host_response_owner
    assert owner is not None
    assert owner.response_id is None

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="never-started",
            status="cancelled",
            reason="replayed",
        )
    )

    # No fence was armed: the live urgent pending is untouched and the owner
    # survives to bind its real start.
    assert service._urgent_host_response_owner is not None
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="urgent-1"))
    assert service._urgent_host_response_owner is not None
    assert service._urgent_host_response_owner.response_id == "urgent-1"


@pytest.mark.asyncio
async def test_stale_playback_stop_cannot_release_replacement_urgent_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, provider, runtime, _frames = make_real_guard_service("d-first", "d-second", "d-third")
    await service.connect()
    runtime._process_event(guard_handoff("d-first"), reclaim=True)
    await service.flush_host_items()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="urgent-first"))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="urgent-first", pcm=b"\x00\x01")
    )
    generation = service.session.current_generation
    assert generation is not None

    runtime._process_event(guard_handoff("d-second"), reclaim=True)
    await service.flush_host_items()
    cancel_started = asyncio.Event()
    release_cancel = asyncio.Event()
    real_cancel = provider.cancel_response

    async def pausing_first_cancel(response_id: str) -> None:
        await real_cancel(response_id)
        if response_id == "urgent-first":
            cancel_started.set()
            await release_cancel.wait()

    monkeypatch.setattr(provider, "cancel_response", pausing_first_cancel)
    stop = asyncio.create_task(
        service.playback_stopped(generation.utterance_id, generation.generation_epoch)
    )
    await asyncio.wait_for(cancel_started.wait(), timeout=0.2)

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="urgent-first",
            status="cancelled",
            reason="renderer_stopped",
        )
    )
    assert [item.event_id for item in provider.injected] == ["final:d-first", "final:d-second"]
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="urgent-second"))

    release_cancel.set()
    assert await stop
    runtime._process_event(guard_handoff("d-third"), reclaim=True)
    await service.flush_host_items()

    assert "cancel:urgent-second" not in provider.actions
    assert [queued.intent.item.event_id for queued in service._host_items] == ["final:d-third"]


@pytest.mark.parametrize("status", ["completed", "cancelled", "failed"])
@pytest.mark.asyncio
async def test_urgent_marker_releases_on_accepted_terminal_without_audio(status: str) -> None:
    service, provider, runtime, _frames = make_real_guard_service("d-first", "d-second")
    await service.connect()
    runtime._process_event(guard_handoff("d-first"), reclaim=True)
    await service.flush_host_items()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="urgent-first"))
    runtime._process_event(guard_handoff("d-second"), reclaim=True)

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="urgent-first",
            status=status,
            reason="completed" if status == "completed" else "provider_terminal",
        )
    )

    # The accepted terminal releases the first marker; the same delivery pass
    # accepts the queued second urgent response and marks that new response active.
    assert service._urgent_host_response_owner is not None
    assert [item.event_id for item in provider.injected] == ["final:d-first", "final:d-second"]


@pytest.mark.asyncio
async def test_urgent_marker_releases_on_playback_cleared() -> None:
    service, _provider, runtime, _frames = make_real_guard_service("d-first")
    await service.connect()
    runtime._process_event(guard_handoff("d-first"), reclaim=True)
    await service.flush_host_items()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="urgent-first"))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="urgent-first", pcm=b"\x00\x01")
    )
    generation = service.session.current_generation
    assert generation is not None

    await service.local_speech_onset("barge-in")
    assert service.playback_cleared(generation.utterance_id, generation.generation_epoch)
    assert service._urgent_host_response_owner is None


@pytest.mark.asyncio
async def test_urgent_marker_releases_on_playback_stopped() -> None:
    service, _provider, runtime, _frames = make_real_guard_service("d-first")
    await service.connect()
    runtime._process_event(guard_handoff("d-first"), reclaim=True)
    await service.flush_host_items()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="urgent-first"))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="urgent-first", pcm=b"\x00\x01")
    )
    generation = service.session.current_generation
    assert generation is not None

    assert await service.playback_stopped(
        generation.utterance_id,
        generation.generation_epoch,
    )
    assert service._urgent_host_response_owner is None


@pytest.mark.asyncio
async def test_reconnect_replays_prestart_urgent_once_as_new_session_activation() -> None:
    """A recoverable error after create-but-before-start must not lose the Guard fact."""
    service, provider, runtime, _frames = make_real_guard_service("d-first")
    await service.connect()
    runtime._process_event(guard_handoff("d-first"), reclaim=True)
    await service.flush_host_items()

    await service.handle_event(
        ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
    )
    assert [
        intent.item.event_id
        for intent, epoch in zip(
            provider.response_intents,
            provider.response_epochs,
            strict=True,
        )
        if epoch == 2
    ] == ["final:d-first"]
    guard_injections = [
        (item.event_id, epoch, activation)
        for item, epoch, activation in zip(
            provider.injected,
            provider.injected_epochs,
            provider.user_activations,
            strict=True,
        )
        if item.event_id == "final:d-first"
    ]
    assert guard_injections == [
        ("final:d-first", 1, False),
        ("final:d-first", 2, True),
    ]


@pytest.mark.asyncio
async def test_guard_queued_before_reconnect_activates_the_fresh_session() -> None:
    service, provider, runtime, _frames = make_real_guard_service("d-first")
    await service.connect()
    runtime._process_event(guard_handoff("d-first"), reclaim=True)

    await service.handle_event(
        ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
    )

    guard_injections = [
        (item.event_id, epoch, activation)
        for item, epoch, activation in zip(
            provider.injected,
            provider.injected_epochs,
            provider.user_activations,
            strict=True,
        )
        if item.event_id == "final:d-first"
    ]
    assert guard_injections == [("final:d-first", 2, True)]
    assert provider.response_epochs == [2]


@pytest.mark.asyncio
async def test_guard_arriving_after_reconnect_activates_fresh_session_once() -> None:
    service, provider, runtime, _frames = make_real_guard_service("d-first", "d-second")
    await service.connect()

    await service.handle_event(
        ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
    )
    runtime._process_event(guard_handoff("d-first"), reclaim=True)
    await service.flush_host_items()

    first_index = next(
        index for index, item in enumerate(provider.injected) if item.event_id == "final:d-first"
    )
    assert provider.user_activations[first_index] is True
    await service.handle_event(ResponseStarted(session_epoch=2, response_id="guard-first"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=2,
            response_id="guard-first",
            status="completed",
            reason="completed",
        )
    )

    runtime._process_event(guard_handoff("d-second"), reclaim=True)
    await service.flush_host_items()

    second_index = next(
        index for index, item in enumerate(provider.injected) if item.event_id == "final:d-second"
    )
    assert provider.user_activations[second_index] is False


@pytest.mark.asyncio
async def test_real_user_input_consumes_fresh_session_activation_need() -> None:
    service, provider, runtime, _frames = make_real_guard_service("d-first")
    await service.connect()
    await service.handle_event(
        ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
    )
    await service.handle_event(
        UserSpeechStarted(
            session_epoch=2,
            speech_id="speech-2",
            provider_item_id="user-item-2",
        )
    )

    runtime._process_event(guard_handoff("d-first"), reclaim=True)
    await service.handle_event(UserSpeechEnded(session_epoch=2, speech_id="speech-2"))
    await service.flush_host_items()

    guard_index = next(
        index for index, item in enumerate(provider.injected) if item.event_id == "final:d-first"
    )
    assert provider.user_activations[guard_index] is False


@pytest.mark.asyncio
async def test_non_guard_preemptive_fact_stays_system_role_across_reconnect() -> None:
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    service._queue_host_item(host_fact("priority-not-guard"), priority=90, preemptive=True)

    await service.handle_event(
        ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
    )

    fact_index = next(
        index
        for index, item in enumerate(provider.injected)
        if item.event_id == "priority-not-guard"
    )
    assert provider.user_activations[fact_index] is False


@pytest.mark.asyncio
async def test_non_guard_prestart_owner_replay_stays_system_role() -> None:
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    service._queue_host_item(host_fact("priority-not-guard"), priority=90, preemptive=True)
    await service.flush_host_items()

    await service.handle_event(
        ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
    )

    injections = [
        activation
        for item, activation in zip(
            provider.injected,
            provider.user_activations,
            strict=True,
        )
        if item.event_id == "priority-not-guard"
    ]
    assert injections == [False, False]


@pytest.mark.parametrize("cleanup", ["close", "fatal"], ids=("close", "provider-fatal"))
@pytest.mark.asyncio
async def test_cleanup_cannot_be_rearmed_by_inflight_urgent_delivery(
    cleanup: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, _provider, _runtime, _frames = make_service()
    await service.connect()
    delivery_accepted = asyncio.Event()
    release_delivery = asyncio.Event()
    real_deliver = service.session.deliver_host_response

    async def pausing_accepted_delivery(intent: HostResponseIntent) -> HostResponseDelivery:
        delivered = await real_deliver(intent)
        delivery_accepted.set()
        await release_delivery.wait()
        return delivered

    monkeypatch.setattr(service.session, "deliver_host_response", pausing_accepted_delivery)
    service._queue_host_item(host_fact("urgent-race"), priority=90, preemptive=True)
    delivery = asyncio.create_task(service.flush_host_items())
    await asyncio.wait_for(delivery_accepted.wait(), timeout=0.2)
    try:
        if cleanup == "close":
            await service.close()
        else:
            await service.handle_event(
                ProviderErrorEvent(session_epoch=1, code="fatal", recoverable=False)
            )
    finally:
        release_delivery.set()
    await delivery

    assert service._urgent_host_response_owner is None


@pytest.mark.asyncio
async def test_reconnect_cannot_be_rearmed_by_old_epoch_urgent_delivery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, _provider, _runtime, _frames = make_service()
    await service.connect()
    delivery_accepted = asyncio.Event()
    release_delivery = asyncio.Event()
    reconnect_cleared_marker = asyncio.Event()
    real_deliver = service.session.deliver_host_response
    real_clear_captions = service._clear_captions

    async def pausing_accepted_delivery(intent: HostResponseIntent) -> HostResponseDelivery:
        delivered = await real_deliver(intent)
        delivery_accepted.set()
        await release_delivery.wait()
        return delivered

    def observe_reconnect_clear() -> None:
        real_clear_captions()
        reconnect_cleared_marker.set()

    monkeypatch.setattr(service.session, "deliver_host_response", pausing_accepted_delivery)
    monkeypatch.setattr(service, "_clear_captions", observe_reconnect_clear)
    service._queue_host_item(host_fact("urgent-old-epoch"), priority=90, preemptive=True)
    delivery = asyncio.create_task(service.flush_host_items())
    await asyncio.wait_for(delivery_accepted.wait(), timeout=0.2)
    reconnect = asyncio.create_task(
        service.handle_event(
            ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
        )
    )
    await asyncio.wait_for(reconnect_cleared_marker.wait(), timeout=0.2)

    release_delivery.set()
    await delivery
    await reconnect

    assert service._urgent_host_response_owner is None


@pytest.mark.asyncio
async def test_reconnect_cannot_clear_urgent_delivered_during_recovery_injection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, provider, runtime, _frames = make_real_guard_service("d-first", "d-second")
    await service.connect()
    recovery_injection_started = asyncio.Event()
    release_recovery_injection = asyncio.Event()
    real_inject = provider.inject_host_item

    async def pausing_recovery_injection(
        item: HostContextItem,
        *,
        confirmation_timeout: float | None = None,
        as_user_activation: bool = False,
    ) -> ItemIdentity:
        if item.kind == "recovery":
            recovery_injection_started.set()
            await release_recovery_injection.wait()
        return await real_inject(
            item,
            confirmation_timeout=confirmation_timeout,
            as_user_activation=as_user_activation,
        )

    monkeypatch.setattr(provider, "inject_host_item", pausing_recovery_injection)
    reconnect = asyncio.create_task(
        service.handle_event(
            ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
        )
    )
    await asyncio.wait_for(recovery_injection_started.wait(), timeout=0.2)
    assert service.session.session_epoch == 2

    runtime._process_event(guard_handoff("d-first"), reclaim=True)
    delivery = asyncio.create_task(service.flush_host_items())
    await asyncio.sleep(0)
    assert not delivery.done()

    release_recovery_injection.set()
    await asyncio.gather(reconnect, delivery)
    assert provider.response_epochs == [2]
    first_index = next(
        index for index, item in enumerate(provider.injected) if item.event_id == "final:d-first"
    )
    assert provider.user_activations[first_index] is True
    await service.handle_event(ResponseStarted(session_epoch=2, response_id="urgent-first"))
    runtime._process_event(guard_handoff("d-second"), reclaim=True)
    await service.flush_host_items()

    assert "cancel:urgent-first" not in provider.actions
    assert [queued.intent.item.event_id for queued in service._host_items] == ["final:d-second"]


@pytest.mark.asyncio
async def test_urgent_delivery_accepted_after_reconnect_arms_new_epoch_shield(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, provider, runtime, _frames = make_real_guard_service("d-first", "d-second")
    await service.connect()
    urgent_injection_started = asyncio.Event()
    release_urgent_injection = asyncio.Event()
    reconnect_cleared_marker = asyncio.Event()
    real_inject = provider.inject_host_item
    real_clear_captions = service._clear_captions

    async def pausing_urgent_injection(
        item: HostContextItem,
        *,
        confirmation_timeout: float | None = None,
        as_user_activation: bool = False,
    ) -> ItemIdentity:
        if item.event_id == "final:d-first":
            urgent_injection_started.set()
            await release_urgent_injection.wait()
        return await real_inject(
            item,
            confirmation_timeout=confirmation_timeout,
            as_user_activation=as_user_activation,
        )

    def observe_reconnect_clear() -> None:
        real_clear_captions()
        reconnect_cleared_marker.set()

    monkeypatch.setattr(provider, "inject_host_item", pausing_urgent_injection)
    monkeypatch.setattr(service, "_clear_captions", observe_reconnect_clear)
    runtime._process_event(guard_handoff("d-first"), reclaim=True)
    delivery = asyncio.create_task(service.flush_host_items())
    await asyncio.wait_for(urgent_injection_started.wait(), timeout=0.2)
    reconnect = asyncio.create_task(
        service.handle_event(
            ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
        )
    )
    await asyncio.sleep(0)
    assert not reconnect_cleared_marker.is_set()

    release_urgent_injection.set()
    await delivery
    await reconnect
    assert reconnect_cleared_marker.is_set()

    guard_attempts = [
        (epoch, activation)
        for item, epoch, activation in zip(
            provider.injected,
            provider.injected_epochs,
            provider.user_activations,
            strict=True,
        )
        if item.event_id == "final:d-first"
    ]
    assert guard_attempts == [(1, False), (2, True)]
    assert provider.response_epochs == [1, 2]

    await service.handle_event(ResponseStarted(session_epoch=2, response_id="urgent-first"))
    runtime._process_event(guard_handoff("d-second"), reclaim=True)
    await service.flush_host_items()

    assert "cancel:urgent-first" not in provider.actions
    assert [queued.intent.item.event_id for queued in service._host_items] == ["final:d-second"]


@pytest.mark.asyncio
async def test_pruned_accepted_urgent_delivery_still_arms_shield() -> None:
    service, provider, runtime, _frames = make_real_guard_service("d-first", "d-second")
    await service.connect()
    for index in range(501):
        tool_output = HostContextItem.tool_output(
            host_item_id=f"host-unresolved-{index}",
            event_id=f"event-unresolved-{index}",
            call_id=f"call-unresolved-{index}",
            content='{"state":"accepted"}',
        )
        assert await service.session.inject_tool_output(tool_output)

    runtime._process_event(guard_handoff("d-first"), reclaim=True)
    await service.flush_host_items()

    assert "final:d-first" not in service.session._injected_event_epochs
    assert provider.response_epochs == [1]

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="urgent-first"))
    runtime._process_event(guard_handoff("d-second"), reclaim=True)
    await service.flush_host_items()

    assert "cancel:urgent-first" not in provider.actions
    assert [queued.intent.item.event_id for queued in service._host_items] == ["final:d-second"]


@pytest.mark.asyncio
async def test_preemptive_delivery_returning_false_does_not_arm_urgent_marker() -> None:
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    intent = host_fact("duplicate-urgent")
    assert (await service.session.deliver_host_response(intent)).accepted
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="duplicate-first"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="duplicate-first",
            status="completed",
            reason="completed",
        )
    )

    service._queue_host_item(intent, priority=90, preemptive=True)
    await service.flush_host_items()

    assert service._urgent_host_response_owner is None
    assert [item.event_id for item in provider.injected] == ["duplicate-urgent"]


@pytest.mark.asyncio
async def test_failed_preemptive_delivery_does_not_arm_urgent_marker() -> None:
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    provider.inject_failures = 1
    service._queue_host_item(host_fact("failing-urgent"), priority=90, preemptive=True)

    with pytest.raises(RealtimeDeliveryError, match="host item injection failed"):
        await service.flush_host_items()

    assert service._urgent_host_response_owner is None
    assert [queued.intent.item.event_id for queued in service._host_items] == ["failing-urgent"]


@pytest.mark.asyncio
async def test_uncertain_host_item_delivery_reconnects_then_retries_in_new_epoch() -> None:
    """Retrying uncertain delivery in the same epoch could duplicate a provider item."""
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    provider.uncertain_inject_attempts = {1}
    service._queue_host_item(host_fact("uncertain-host"))

    await service.flush_host_items()

    assert provider.epoch == 2
    assert provider.inject_attempts == 3
    assert [item.kind for item in provider.injected] == ["recovery", "progress"]
    assert provider.injected[1].event_id == "uncertain-host"
    assert provider.injected_epochs == [2, 2]
    assert [item.intent.item.event_id for item in service._host_items] == []
    assert [intent.item.event_id for intent in provider.response_intents] == ["uncertain-host"]


@pytest.mark.asyncio
async def test_second_uncertain_delivery_stops_without_another_reconnect() -> None:
    """A permanently missing confirmation must not form an epoch/retry loop."""
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    provider.uncertain_inject_attempts = {1, 3}
    service._queue_host_item(host_fact("uncertain-twice"))

    await service.flush_host_items()

    assert provider.epoch == 2
    assert provider.inject_attempts == 3
    assert service._provider_failed
    assert service._stop.is_set()
    assert [queued.intent.item.event_id for queued in service._host_items] == ["uncertain-twice"]
    assert provider.response_intents == []


@pytest.mark.asyncio
async def test_uncertain_recovery_frame_stops_without_recursive_reconnect() -> None:
    """Recovery confirmation uncertainty cannot safely be recovered inside that epoch."""
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    provider.uncertain_inject_attempts = {1, 2}
    service._queue_host_item(host_fact("uncertain-recovery"))

    await service.flush_host_items()

    assert provider.epoch == 2
    assert provider.inject_attempts == 2
    assert service._provider_failed
    assert service._stop.is_set()
    assert [queued.intent.item.event_id for queued in service._host_items] == ["uncertain-recovery"]
    assert provider.response_intents == []


@pytest.mark.asyncio
async def test_concurrent_reconnect_causes_create_only_one_replacement_epoch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A recoverable provider error racing item uncertainty shares one reconnect."""
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    provider.uncertain_inject_attempts = {1}
    service._queue_host_item(host_fact("uncertain-race"))
    reconnect_entered = asyncio.Event()
    release_reconnect = asyncio.Event()
    original_connect = provider.connect

    async def pausing_connect(*, tools: tuple[dict[str, object], ...]) -> SessionIdentity:
        if provider.epoch == 1:
            reconnect_entered.set()
            await release_reconnect.wait()
        return await original_connect(tools=tools)

    monkeypatch.setattr(provider, "connect", pausing_connect)
    first = asyncio.create_task(service.flush_host_items())
    await asyncio.wait_for(reconnect_entered.wait(), timeout=0.1)
    second = asyncio.create_task(
        service.handle_event(
            ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
        )
    )
    await asyncio.sleep(0)
    release_reconnect.set()

    await asyncio.gather(first, second)

    assert provider.epoch == 2
    assert provider.actions.count("close") == 1
    assert [item.kind for item in provider.injected] == ["recovery", "progress"]
    assert [intent.item.event_id for intent in provider.response_intents] == ["uncertain-race"]


@pytest.mark.asyncio
async def test_delivery_timeout_reconnect_keeps_consuming_replacement_epoch_events(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The old stream sentinel must not terminate the sole service receive task."""
    service, provider, _runtime, _frames = make_service()
    provider.uncertain_inject_attempts = {1}
    replacement_connected = asyncio.Event()
    replacement_event_consumed = asyncio.Event()
    keep_replacement_open = asyncio.Event()

    async def per_epoch_events():
        stream_epoch = provider.epoch
        if stream_epoch == 1:
            await replacement_connected.wait()
            yield ProviderErrorEvent(
                session_epoch=1,
                code="disconnected",
                recoverable=True,
            )
            return
        if stream_epoch == 2:
            yield UserSpeechStarted(
                session_epoch=2,
                speech_id="replacement-speech",
                provider_item_id="replacement-item",
            )
            replacement_event_consumed.set()
            await keep_replacement_open.wait()

    original_connect = provider.connect

    async def connect_epoch(*, tools: tuple[dict[str, object], ...]) -> SessionIdentity:
        identity = await original_connect(tools=tools)
        if identity.epoch == 2:
            replacement_connected.set()
        return identity

    monkeypatch.setattr(provider, "events", per_epoch_events)
    monkeypatch.setattr(provider, "connect", connect_epoch)
    await service.start()
    service._queue_host_item(host_fact("uncertain-live-stream"))
    try:
        await wait_for_stream_advance_without_service_stop(
            service,
            replacement_event_consumed,
        )

        assert provider.epoch == 2
        assert service.session.floor.state == "user_speaking"
        assert not service.stopped
    finally:
        keep_replacement_open.set()
        await service.close()


@pytest.mark.asyncio
async def test_replayed_guard_hit_cannot_cancel_active_assistant_or_queue_final() -> None:
    service, provider, runtime, _frames = make_real_guard_service("d-guard")
    await service.connect()
    first = guard_handoff("d-guard")
    runtime._process_event(first, reclaim=True)
    await service.flush_host_items()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="guard-first"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="guard-first",
            status="completed",
            reason="completed",
        )
    )
    await start_audible_response(service, "assistant-active")
    before_actions = tuple(provider.actions)

    replay = guard_handoff("d-guard")
    runtime._process_event(replay, reclaim=True)
    await service.flush_host_items()

    assert tuple(provider.actions) == before_actions
    assert service._host_items == []
    assert service._pending_preempt_priority is None


def test_unknown_non_codex_handoff_does_not_settle_queue_or_arm_preemption() -> None:
    service, _provider, _runtime, _frames = make_service(executor_names=("guard",))

    service.project_runtime_event(guard_handoff("d-forged"))

    assert service.session.delegate_state("d-forged") is None
    assert service._host_items == []
    assert service._pending_preempt_priority is None


@pytest.mark.asyncio
async def test_priority_heap_delivers_guard_before_older_codex() -> None:
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    service._queue_host_item(host_fact("codex-old"), priority=50)
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)

    await service.flush_host_items()

    assert provider.injected[0].event_id == "guard-hit"


@pytest.mark.asyncio
async def test_guard_hit_preempts_assistant_audio_and_is_next() -> None:
    service, provider, runtime, _frames = make_service(executor_names=("codex", "guard"))
    runtime.executors["guard"] = FakeExecutor("guard", priority=90)
    await service.connect()
    await start_audible_response(service, "assistant-active")
    generation = service.session.current_generation
    assert generation is not None
    service._queue_host_item(host_fact("codex-old"), priority=50)
    event = guard_handoff("d-guard")
    project_claimed_handoff(service, runtime, event)

    await service.flush_host_items()

    assert provider.actions[-1] == "cancel:assistant-active"
    assert not any(action.startswith("clear:") for action in provider.actions)
    assert service.session.current_generation == generation
    assert provider.injected == []
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="assistant-active",
            status="cancelled",
            reason="client_cancelled",
        )
    )
    assert provider.injected[-1].event_id == "final:d-guard"
    assert service.session.current_generation == generation

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="guard-response"))
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="guard-response",
            pcm=b"\x02\x03",
        )
    )

    assert provider.actions[-1] == "clear:utterance-progress:1"
    assert service.session.current_generation is not None
    assert service.session.current_generation.response_id == "guard-response"


@pytest.mark.asyncio
async def test_cancel_rejection_is_inert_when_controlled_guard_reconnect_is_disabled() -> None:
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    await start_audible_response(service, "automatic-response")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()

    await service.handle_event(
        ResponseCancelRejected(
            session_epoch=1,
            response_id="automatic-response",
            cancel_request_id="cancel-1",
            reason="no_active_response",
        )
    )

    assert provider.epoch == 1
    assert provider.actions.count("close") == 0
    assert provider.response_intents == []
    assert [queued.intent.item.event_id for queued in service._host_items] == ["guard-hit"]


@pytest.mark.asyncio
async def test_matching_automatic_cancel_rejection_reconnects_and_delivers_guard_once() -> None:
    service, provider, _runtime, _frames = make_service(controlled_guard_reconnect=True)
    await service.connect()
    await start_audible_response(service, "automatic-response")
    old_generation = service.session.current_generation
    assert old_generation is not None
    assert service.playback_started(
        old_generation.utterance_id,
        old_generation.generation_epoch,
    )
    service._queue_host_item(
        host_fact("final:d-guard"),
        priority=90,
        preemptive=True,
        guard_delegate_id="d-guard",
    )
    await service.flush_host_items()

    rejection = ResponseCancelRejected(
        session_epoch=1,
        response_id="automatic-response",
        cancel_request_id="cancel-1",
        reason="no_active_response",
    )
    await service.handle_event(rejection)
    await service.handle_event(rejection)

    assert provider.epoch == 2
    assert provider.actions.count("close") == 1
    assert [item.kind for item in provider.injected] == ["recovery", "progress"]
    assert [item.event_id for item in provider.injected[1:]] == ["final:d-guard"]
    assert [intent.item.event_id for intent in provider.response_intents] == ["final:d-guard"]
    assert provider.confirmation_timeouts == [0.5, 0.5]
    assert provider.user_activations == [False, True]
    assert service.session.current_generation == old_generation
    assert service._host_items == []


@pytest.mark.asyncio
async def test_cancel_rejection_racing_cancel_send_return_still_reconnects_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, provider, _runtime, _frames = make_service(controlled_guard_reconnect=True)
    await service.connect()
    await start_audible_response(service, "automatic-response")
    cancel_entered = asyncio.Event()
    release_cancel = asyncio.Event()
    real_cancel = provider.cancel_response

    async def delayed_cancel(response_id: str) -> None:
        await real_cancel(response_id)
        cancel_entered.set()
        await release_cancel.wait()

    monkeypatch.setattr(provider, "cancel_response", delayed_cancel)
    service._queue_host_item(
        host_fact("final:d-guard"),
        priority=90,
        preemptive=True,
        guard_delegate_id="d-guard",
    )
    preempt = asyncio.create_task(service.flush_host_items())
    await asyncio.wait_for(cancel_entered.wait(), timeout=0.2)
    armed = service._guard_preemption
    assert armed is not None
    assert armed.old_response_id == "automatic-response"
    rejection = asyncio.create_task(
        service.handle_event(
            ResponseCancelRejected(
                session_epoch=1,
                response_id="automatic-response",
                cancel_request_id="cancel-1",
                reason="no_active_response",
            )
        )
    )
    await asyncio.sleep(0)
    release_cancel.set()

    await asyncio.gather(preempt, rejection)

    assert provider.epoch == 2
    assert provider.actions.count("close") == 1
    assert [intent.item.event_id for intent in provider.response_intents] == ["final:d-guard"]


@pytest.mark.asyncio
async def test_cancel_rejection_for_host_created_response_never_reconnects() -> None:
    service, provider, _runtime, _frames = make_service(controlled_guard_reconnect=True)
    await service.connect()
    assert await service.session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="ordinary-item",
            event_id="ordinary-event",
            content="ordinary response",
        )
    )
    await start_audible_response(service, "manual-response")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()

    await service.handle_event(
        ResponseCancelRejected(
            session_epoch=1,
            response_id="manual-response",
            cancel_request_id="cancel-1",
            reason="no_active_response",
        )
    )

    assert provider.epoch == 1
    assert provider.actions.count("close") == 0
    assert [intent.item.event_id for intent in provider.response_intents] == ["ordinary-event"]
    assert [queued.intent.item.event_id for queued in service._host_items] == ["guard-hit"]


@pytest.mark.asyncio
async def test_unrelated_cancel_rejection_cannot_consume_guard_reconnect_permit() -> None:
    service, provider, _runtime, _frames = make_service(controlled_guard_reconnect=True)
    await service.connect()
    await start_audible_response(service, "automatic-response")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()

    await service.handle_event(
        ResponseCancelRejected(
            session_epoch=1,
            response_id="other-response",
            cancel_request_id="cancel-other",
            reason="no_active_response",
        )
    )
    await service.handle_event(
        ResponseCancelRejected(
            session_epoch=1,
            response_id="automatic-response",
            cancel_request_id="cancel-real",
            reason="no_active_response",
        )
    )

    assert provider.epoch == 2
    assert provider.actions.count("close") == 1
    assert [intent.item.event_id for intent in provider.response_intents] == ["guard-hit"]


@pytest.mark.asyncio
async def test_user_speech_before_cancel_rejection_disables_controlled_reconnect() -> None:
    service, provider, _runtime, _frames = make_service(controlled_guard_reconnect=True)
    await service.connect()
    await start_audible_response(service, "automatic-response")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await service.handle_event(UserSpeechStarted(session_epoch=1, speech_id="user-barge-in"))

    await service.handle_event(
        ResponseCancelRejected(
            session_epoch=1,
            response_id="automatic-response",
            cancel_request_id="cancel-1",
            reason="no_active_response",
        )
    )

    assert provider.epoch == 1
    assert provider.actions.count("close") == 0
    assert provider.response_intents == []


@pytest.mark.asyncio
async def test_local_onset_before_cancel_rejection_disables_controlled_reconnect() -> None:
    service, provider, _runtime, _frames = make_service(controlled_guard_reconnect=True)
    await service.connect()
    await start_audible_response(service, "automatic-response")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()

    await service.local_speech_onset("local-barge-in")
    await service.handle_event(
        ResponseCancelRejected(
            session_epoch=1,
            response_id="automatic-response",
            cancel_request_id="cancel-1",
            reason="no_active_response",
        )
    )

    assert provider.epoch == 1
    assert provider.actions.count("close") == 0
    assert provider.response_intents == []


@pytest.mark.asyncio
async def test_old_terminal_before_cancel_rejection_disables_controlled_reconnect() -> None:
    service, provider, _runtime, _frames = make_service(controlled_guard_reconnect=True)
    await service.connect()
    await start_audible_response(service, "automatic-response")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="automatic-response",
            status="completed",
            reason="completed",
        )
    )

    await service.handle_event(
        ResponseCancelRejected(
            session_epoch=1,
            response_id="automatic-response",
            cancel_request_id="cancel-late",
            reason="no_active_response",
        )
    )

    assert provider.epoch == 1
    assert provider.actions.count("close") == 0
    assert [intent.item.event_id for intent in provider.response_intents] == ["guard-hit"]


@pytest.mark.asyncio
async def test_guard_reconnect_keeps_original_deadline_during_slow_handshake(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = VirtualClock()
    alerts: list[tuple[str | None, int | None]] = []
    service, provider, _runtime, _frames = make_service(
        clock=clock,
        alerts=alerts,
        controlled_guard_reconnect=True,
    )
    await service.connect()
    await start_audible_response(service, "automatic-response")
    old_generation = service.session.current_generation
    assert old_generation is not None
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await asyncio.sleep(0)
    connect_entered = asyncio.Event()
    release_connect = asyncio.Event()
    real_connect = provider.connect

    async def delayed_connect(*, tools: tuple[dict[str, object], ...]) -> SessionIdentity:
        if provider.epoch == 1:
            connect_entered.set()
            await release_connect.wait()
        return await real_connect(tools=tools)

    monkeypatch.setattr(provider, "connect", delayed_connect)
    reconnect = asyncio.create_task(
        service.handle_event(
            ResponseCancelRejected(
                session_epoch=1,
                response_id="automatic-response",
                cancel_request_id="cancel-1",
                reason="no_active_response",
            )
        )
    )
    await asyncio.wait_for(connect_entered.wait(), timeout=0.2)

    clock.advance_to(GUARD_ALERT_DEADLINE_S)
    await asyncio.sleep(0)

    assert alerts == [(old_generation.utterance_id, old_generation.generation_epoch)]
    release_connect.set()
    await reconnect
    assert [intent.item.event_id for intent in provider.response_intents] == ["guard-hit"]


@pytest.mark.asyncio
async def test_guard_reconnect_blocks_ordinary_flush_until_guard_is_created(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, provider, _runtime, _frames = make_service(controlled_guard_reconnect=True)
    await service.connect()
    await start_audible_response(service, "automatic-response")
    service._queue_host_item(host_fact("ordinary-later"), priority=50)
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    connect_entered = asyncio.Event()
    release_connect = asyncio.Event()
    real_connect = provider.connect

    async def delayed_connect(*, tools: tuple[dict[str, object], ...]) -> SessionIdentity:
        if provider.epoch == 1:
            connect_entered.set()
            await release_connect.wait()
        return await real_connect(tools=tools)

    monkeypatch.setattr(provider, "connect", delayed_connect)
    reconnect = asyncio.create_task(
        service.handle_event(
            ResponseCancelRejected(
                session_epoch=1,
                response_id="automatic-response",
                cancel_request_id="cancel-1",
                reason="no_active_response",
            )
        )
    )
    await asyncio.wait_for(connect_entered.wait(), timeout=0.2)
    ordinary_flush = asyncio.create_task(service.flush_host_items())
    await asyncio.sleep(0)
    assert not ordinary_flush.done()

    release_connect.set()
    await asyncio.gather(reconnect, ordinary_flush)

    assert [intent.item.event_id for intent in provider.response_intents] == ["guard-hit"]
    assert [queued.intent.item.event_id for queued in service._host_items] == ["ordinary-later"]


@pytest.mark.asyncio
async def test_guard_reconnect_delivers_captured_guard_before_later_higher_priority_hit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, provider, _runtime, _frames = make_service(controlled_guard_reconnect=True)
    await service.connect()
    await start_audible_response(service, "automatic-response")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    connect_entered = asyncio.Event()
    release_connect = asyncio.Event()
    real_connect = provider.connect

    async def delayed_connect(*, tools: tuple[dict[str, object], ...]) -> SessionIdentity:
        if provider.epoch == 1:
            connect_entered.set()
            await release_connect.wait()
        return await real_connect(tools=tools)

    monkeypatch.setattr(provider, "connect", delayed_connect)
    reconnect = asyncio.create_task(
        service.handle_event(
            ResponseCancelRejected(
                session_epoch=1,
                response_id="automatic-response",
                cancel_request_id="cancel-1",
                reason="no_active_response",
            )
        )
    )
    await asyncio.wait_for(connect_entered.wait(), timeout=0.2)

    service._queue_host_item(host_fact("later-higher-hit"), priority=95, preemptive=True)
    release_connect.set()
    await reconnect

    assert [intent.item.event_id for intent in provider.response_intents] == ["guard-hit"]
    assert [queued.intent.item.event_id for queued in service._host_items] == ["later-higher-hit"]


@pytest.mark.asyncio
async def test_guard_reconnect_failure_stops_without_retry_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, provider, _runtime, _frames = make_service(controlled_guard_reconnect=True)
    await service.connect()
    await start_audible_response(service, "automatic-response")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    connect_calls = 0

    async def failed_connect(*, tools: tuple[dict[str, object], ...]) -> SessionIdentity:
        nonlocal connect_calls
        del tools
        connect_calls += 1
        raise RuntimeError("replacement connect failed")

    monkeypatch.setattr(provider, "connect", failed_connect)
    rejection = ResponseCancelRejected(
        session_epoch=1,
        response_id="automatic-response",
        cancel_request_id="cancel-1",
        reason="no_active_response",
    )

    await service.handle_event(rejection)
    await service.handle_event(rejection)

    assert connect_calls == 1
    assert provider.actions.count("close") == 1
    assert provider.response_intents == []
    assert service._provider_failed
    assert service.stopped


@pytest.mark.asyncio
async def test_guard_reconnect_cancellation_stops_partial_transition(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, provider, _runtime, _frames = make_service(controlled_guard_reconnect=True)
    await service.connect()
    await start_audible_response(service, "automatic-response")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    connect_entered = asyncio.Event()
    never_release = asyncio.Event()

    async def blocked_connect(*, tools: tuple[dict[str, object], ...]) -> SessionIdentity:
        del tools
        connect_entered.set()
        await never_release.wait()
        raise AssertionError("unreachable")

    monkeypatch.setattr(provider, "connect", blocked_connect)
    reconnect = asyncio.create_task(
        service.handle_event(
            ResponseCancelRejected(
                session_epoch=1,
                response_id="automatic-response",
                cancel_request_id="cancel-1",
                reason="no_active_response",
            )
        )
    )
    await asyncio.wait_for(connect_entered.wait(), timeout=0.2)

    reconnect.cancel()
    with pytest.raises(asyncio.CancelledError):
        await reconnect

    assert service._provider_failed
    assert service.stopped
    assert provider.response_intents == []


@pytest.mark.asyncio
async def test_local_barge_in_during_guard_reconnect_suppresses_tone_and_guard_create(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = VirtualClock()
    alerts: list[tuple[str | None, int | None]] = []
    service, provider, _runtime, _frames = make_service(
        clock=clock,
        alerts=alerts,
        controlled_guard_reconnect=True,
    )
    await service.connect()
    await start_audible_response(service, "automatic-response")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    connect_entered = asyncio.Event()
    release_connect = asyncio.Event()
    real_connect = provider.connect

    async def delayed_connect(*, tools: tuple[dict[str, object], ...]) -> SessionIdentity:
        if provider.epoch == 1:
            connect_entered.set()
            await release_connect.wait()
        return await real_connect(tools=tools)

    monkeypatch.setattr(provider, "connect", delayed_connect)
    reconnect = asyncio.create_task(
        service.handle_event(
            ResponseCancelRejected(
                session_epoch=1,
                response_id="automatic-response",
                cancel_request_id="cancel-1",
                reason="no_active_response",
            )
        )
    )
    await asyncio.wait_for(connect_entered.wait(), timeout=0.2)

    await service.local_speech_onset("local-barge-in")
    await asyncio.sleep(0)
    clock.advance_to(GUARD_ALERT_DEADLINE_S)
    await asyncio.sleep(0)

    assert alerts == []
    release_connect.set()
    await reconnect
    assert provider.response_intents == []
    assert [queued.intent.item.event_id for queued in service._host_items] == ["guard-hit"]


@pytest.mark.asyncio
async def test_local_barge_in_during_guard_confirmation_prevents_response_create(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, provider, _runtime, _frames = make_service(controlled_guard_reconnect=True)
    await service.connect()
    await start_audible_response(service, "automatic-response")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    injection_entered = asyncio.Event()
    release_injection = asyncio.Event()
    real_inject = provider.inject_host_item

    async def delayed_inject(
        item: HostContextItem,
        *,
        confirmation_timeout: float | None = None,
        as_user_activation: bool = False,
    ) -> ItemIdentity:
        if item.event_id == "guard-hit":
            injection_entered.set()
            await release_injection.wait()
        return await real_inject(
            item,
            confirmation_timeout=confirmation_timeout,
            as_user_activation=as_user_activation,
        )

    monkeypatch.setattr(provider, "inject_host_item", delayed_inject)
    reconnect = asyncio.create_task(
        service.handle_event(
            ResponseCancelRejected(
                session_epoch=1,
                response_id="automatic-response",
                cancel_request_id="cancel-1",
                reason="no_active_response",
            )
        )
    )
    await asyncio.wait_for(injection_entered.wait(), timeout=0.2)

    await service.local_speech_onset("local-barge-in")
    release_injection.set()
    await reconnect

    assert [item.event_id for item in provider.injected].count("guard-hit") == 1
    assert provider.response_intents == []
    assert [queued.intent.item.event_id for queued in service._host_items] == ["guard-hit"]


@pytest.mark.asyncio
async def test_guard_reconnect_first_audio_switches_without_tone_and_clear_ack_is_exact() -> None:
    clock = VirtualClock()
    alerts: list[tuple[str | None, int | None]] = []
    telemetry_records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            telemetry_records.append((kind, payload))

    service, provider, _runtime, _frames = make_service(
        clock=clock,
        alerts=alerts,
        telemetry=_Telemetry(),
        controlled_guard_reconnect=True,
    )
    await service.connect()
    await start_audible_response(service, "automatic-response")
    old_generation = service.session.current_generation
    assert old_generation is not None
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await service.handle_event(
        ResponseCancelRejected(
            session_epoch=1,
            response_id="automatic-response",
            cancel_request_id="cancel-1",
            reason="no_active_response",
        )
    )

    await service.handle_event(ResponseStarted(session_epoch=2, response_id="guard-response"))
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=2,
            response_id="guard-response",
            pcm=b"\x02\x03",
        )
    )
    new_generation = service.session.current_generation
    assert new_generation is not None and new_generation.session_epoch == 2
    assert alerts == []
    assert (
        provider.actions.count(
            f"clear:{old_generation.utterance_id}:{old_generation.generation_epoch}"
        )
        == 1
    )
    assert service.playback_started(new_generation.utterance_id, new_generation.generation_epoch)
    assert service.playback_cleared(
        old_generation.utterance_id,
        old_generation.generation_epoch,
        100,
    )
    clock.advance_to(GUARD_CLEAR_ACK_DEADLINE_S)
    await asyncio.sleep(0)

    assert not any(kind == "renderer_clear_unknown" for kind, _payload in telemetry_records)
    assert service.session.floor.utterance_id == new_generation.utterance_id


@pytest.mark.asyncio
async def test_packed_history_precedes_recovery_and_guard_after_controlled_reconnect() -> None:
    runtime = Runtime(clock=VirtualClock(), memory=Memory())
    runtime.memory.append(
        CONVERSATION_CHANNEL,
        ts=1,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "最早那个任务怎么运行？"},
    )
    runtime.memory.append(
        CONVERSATION_CHANNEL,
        ts=2,
        trust="trusted_system",
        priority=USER_PRIORITY,
        content={"text": "运行 make demo。", "delivery": "spoken", "played_ms": 300},
    )
    service, provider, _runtime, _frames = make_service(
        runtime=runtime,
        controlled_guard_reconnect=True,
        guard_history_recovery="packed",
    )
    await service.connect()
    await start_audible_response(service, "automatic-response")
    service._queue_host_item(
        host_fact("final:d-guard"),
        priority=90,
        preemptive=True,
        guard_delegate_id="d-guard",
    )
    await service.flush_host_items()

    await service.handle_event(
        ResponseCancelRejected(
            session_epoch=1,
            response_id="automatic-response",
            cancel_request_id="cancel-1",
            reason="no_active_response",
        )
    )

    injected = provider.injected[-3:]
    assert [item.kind for item in injected] == ["dialogue_context", "recovery", "progress"]
    packed = json.loads(injected[0].content)
    assert [turn["role"] for turn in packed["turns"]] == ["user", "assistant"]
    assert [turn["text"] for turn in packed["turns"]] == [
        "最早那个任务怎么运行？",
        "运行 make demo。",
    ]
    assert provider.actions[-1] == "create_response"
    assert provider.user_activations[-3:] == [False, False, True]


@pytest.mark.asyncio
async def test_history_telemetry_records_counts_without_text() -> None:
    runtime = Runtime(clock=VirtualClock(), memory=Memory())
    runtime.memory.append(
        CONVERSATION_CHANNEL,
        ts=1,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "private-history-nonce"},
    )
    runtime.memory.append(
        CONVERSATION_CHANNEL,
        ts=2,
        trust="trusted_system",
        priority=USER_PRIORITY,
        content={"text": "private-answer", "delivery": "spoken", "played_ms": 20},
    )
    records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            records.append((kind, payload))

    service, _provider, _runtime, _frames = make_service(
        runtime=runtime,
        telemetry=_Telemetry(),
        controlled_guard_reconnect=True,
        guard_history_recovery="packed",
    )
    await service.connect()
    await start_audible_response(service, "automatic-response")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await service.handle_event(
        ResponseCancelRejected(
            session_epoch=1,
            response_id="automatic-response",
            cancel_request_id="cancel-1",
            reason="no_active_response",
        )
    )

    history_record = next(payload for kind, payload in records if kind == "guard.history_recovery")
    assert history_record == {
        "arm": "packed",
        "outcome": "packed",
        "item_count": 2,
        "pair_count": 1,
        "character_count": len("private-history-nonceprivate-answer"),
    }
    assert "private" not in json.dumps(history_record)


@pytest.mark.asyncio
async def test_packed_history_telemetry_counts_only_fitted_whole_pairs() -> None:
    runtime = Runtime(clock=VirtualClock(), memory=Memory())
    for pair in range(1, 5):
        runtime.memory.append(
            CONVERSATION_CHANNEL,
            ts=pair * 2 - 1,
            trust="trusted_user",
            priority=USER_PRIORITY,
            content={"text": ('\\"' * 300) + f"q{pair}"},
        )
        runtime.memory.append(
            CONVERSATION_CHANNEL,
            ts=pair * 2,
            trust="trusted_system",
            priority=USER_PRIORITY,
            content={
                "text": ('\\"' * 300) + f"a{pair}",
                "delivery": "spoken",
                "played_ms": 20,
            },
        )
    records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            records.append((kind, payload))

    service, provider, _runtime, _frames = make_service(
        runtime=runtime,
        telemetry=_Telemetry(),
        controlled_guard_reconnect=True,
        guard_history_recovery="packed",
    )
    await service.connect()
    await start_audible_response(service, "automatic-response")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await service.handle_event(
        ResponseCancelRejected(
            session_epoch=1,
            response_id="automatic-response",
            cancel_request_id="cancel-1",
            reason="no_active_response",
        )
    )

    packed = json.loads(
        next(item.content for item in provider.injected if item.kind == "dialogue_context")
    )
    history_record = next(payload for kind, payload in records if kind == "guard.history_recovery")
    assert history_record["item_count"] == len(packed["turns"])
    assert history_record["pair_count"] == len(packed["turns"]) // 2


@pytest.mark.asyncio
async def test_packed_history_omits_item_when_canonical_history_is_empty() -> None:
    service, provider, _runtime, _frames = make_service(
        controlled_guard_reconnect=True,
        guard_history_recovery="packed",
    )
    await service.connect()
    await start_audible_response(service, "automatic-response")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()

    await service.handle_event(
        ResponseCancelRejected(
            session_epoch=1,
            response_id="automatic-response",
            cancel_request_id="cancel-1",
            reason="no_active_response",
        )
    )

    assert [item.kind for item in provider.injected[-2:]] == ["recovery", "progress"]


@pytest.mark.asyncio
async def test_packed_history_uncertainty_degrades_once_to_recovery_and_guard() -> None:
    runtime = Runtime(clock=VirtualClock(), memory=Memory())
    runtime.memory.append(
        CONVERSATION_CHANNEL,
        ts=1,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "问题"},
    )
    runtime.memory.append(
        CONVERSATION_CHANNEL,
        ts=2,
        trust="trusted_system",
        priority=USER_PRIORITY,
        content={"text": "回答", "delivery": "spoken", "played_ms": 50},
    )
    records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            records.append((kind, payload))

    service, provider, _runtime, _frames = make_service(
        runtime=runtime,
        telemetry=_Telemetry(),
        controlled_guard_reconnect=True,
        guard_history_recovery="packed",
    )
    await service.connect()
    await start_audible_response(service, "automatic-response")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    provider.uncertain_inject_attempts.add(1)

    await service.handle_event(
        ResponseCancelRejected(
            session_epoch=1,
            response_id="automatic-response",
            cancel_request_id="cancel-1",
            reason="no_active_response",
        )
    )

    assert provider.inject_attempts == 3
    assert [item.kind for item in provider.injected[-2:]] == ["recovery", "progress"]
    assert provider.actions.count("create_response") == 1
    history = next(payload for kind, payload in records if kind == "guard.history_recovery")
    assert history["outcome"] == "uncertain"


@pytest.mark.asyncio
async def test_guard_reconnect_reused_response_id_waits_for_new_epoch_pcm() -> None:
    clock = VirtualClock()
    alerts: list[tuple[str | None, int | None]] = []
    service, _provider, _runtime, _frames = make_service(
        clock=clock,
        alerts=alerts,
        controlled_guard_reconnect=True,
    )
    await service.connect()
    await start_audible_response(service, "reused-response")
    old_generation = service.session.current_generation
    assert old_generation is not None
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await service.handle_event(
        ResponseCancelRejected(
            session_epoch=1,
            response_id="reused-response",
            cancel_request_id="cancel-1",
            reason="no_active_response",
        )
    )

    await service.handle_event(ResponseStarted(session_epoch=2, response_id="reused-response"))

    assert service._guard_preemption is not None
    assert service.session.current_generation == old_generation
    await asyncio.sleep(0)
    clock.advance_to(GUARD_ALERT_DEADLINE_S)
    await asyncio.sleep(0)
    assert alerts == [(old_generation.utterance_id, old_generation.generation_epoch)]

    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=2,
            response_id="reused-response",
            pcm=b"\x02\x03",
        )
    )
    assert service.session.current_generation is not None
    assert service.session.current_generation.session_epoch == 2


@pytest.mark.asyncio
async def test_guard_reconnect_reused_response_terminal_does_not_bind_old_generation() -> None:
    terminals: list[tuple[str, int]] = []
    service, _provider, _runtime, _frames = make_service(
        terminals=terminals,
        controlled_guard_reconnect=True,
    )
    await service.connect()
    await start_audible_response(service, "reused-response")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await service.handle_event(
        ResponseCancelRejected(
            session_epoch=1,
            response_id="reused-response",
            cancel_request_id="cancel-1",
            reason="no_active_response",
        )
    )
    await service.handle_event(ResponseStarted(session_epoch=2, response_id="reused-response"))

    await service.handle_event(
        ResponseTerminal(
            session_epoch=2,
            response_id="reused-response",
            status="completed",
            reason="completed",
        )
    )

    assert terminals == []
    assert service._urgent_host_response_owner is None


@pytest.mark.asyncio
async def test_guard_reconnect_missing_clear_ack_retires_without_delivery_evidence() -> None:
    clock = VirtualClock()
    telemetry_records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            telemetry_records.append((kind, payload))

    service, _provider, _runtime, _frames = make_service(
        clock=clock,
        telemetry=_Telemetry(),
        controlled_guard_reconnect=True,
    )
    await service.connect()
    await start_audible_response(service, "automatic-response")
    old_generation = service.session.current_generation
    assert old_generation is not None
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await service.handle_event(
        ResponseCancelRejected(
            session_epoch=1,
            response_id="automatic-response",
            cancel_request_id="cancel-1",
            reason="no_active_response",
        )
    )
    await service.handle_event(ResponseStarted(session_epoch=2, response_id="guard-response"))
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=2,
            response_id="guard-response",
            pcm=b"\x02\x03",
        )
    )
    deliveries_before = [action for action in _provider.actions if action.startswith("delivery:")]
    await asyncio.sleep(0)

    clock.advance_to(GUARD_CLEAR_ACK_DEADLINE_S)
    await asyncio.sleep(0)

    assert [kind for kind, _payload in telemetry_records].count("renderer_clear_unknown") == 1
    assert [
        action for action in _provider.actions if action.startswith("delivery:")
    ] == deliveries_before
    assert not service.playback_cleared(
        old_generation.utterance_id,
        old_generation.generation_epoch,
        100,
    )


@pytest.mark.asyncio
async def test_guard_reconnect_after_existing_alert_still_bounds_missing_clear_ack() -> None:
    clock = VirtualClock()
    alerts: list[tuple[str | None, int | None]] = []
    telemetry_records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            telemetry_records.append((kind, payload))

    service, _provider, _runtime, _frames = make_service(
        clock=clock,
        alerts=alerts,
        telemetry=_Telemetry(),
        controlled_guard_reconnect=True,
    )
    await service.connect()
    await start_audible_response(service, "automatic-response")
    old_generation = service.session.current_generation
    assert old_generation is not None
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await asyncio.sleep(0)
    clock.advance_to(GUARD_ALERT_DEADLINE_S)
    await asyncio.sleep(0)
    assert alerts == [(old_generation.utterance_id, old_generation.generation_epoch)]

    await service.handle_event(
        ResponseCancelRejected(
            session_epoch=1,
            response_id="automatic-response",
            cancel_request_id="cancel-1",
            reason="no_active_response",
        )
    )
    await asyncio.sleep(0)
    clock.advance_to(GUARD_ALERT_DEADLINE_S + GUARD_CLEAR_ACK_DEADLINE_S)
    await asyncio.sleep(0)

    assert [kind for kind, _payload in telemetry_records].count("renderer_clear_unknown") == 1
    assert not service.playback_cleared(
        old_generation.utterance_id,
        old_generation.generation_epoch,
        100,
    )


@pytest.mark.asyncio
async def test_guard_alert_clear_ack_deadline_does_not_wait_for_slow_reconnect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = VirtualClock()
    alerts: list[tuple[str | None, int | None]] = []
    telemetry_records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            telemetry_records.append((kind, payload))

    service, provider, _runtime, _frames = make_service(
        clock=clock,
        alerts=alerts,
        telemetry=_Telemetry(),
        controlled_guard_reconnect=True,
    )
    await service.connect()
    await start_audible_response(service, "automatic-response")
    old_generation = service.session.current_generation
    assert old_generation is not None
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await asyncio.sleep(0)
    clock.advance_to(GUARD_ALERT_DEADLINE_S)
    await asyncio.sleep(0)
    assert alerts == [(old_generation.utterance_id, old_generation.generation_epoch)]
    connect_entered = asyncio.Event()
    release_connect = asyncio.Event()
    real_connect = provider.connect

    async def delayed_connect(*, tools: tuple[dict[str, object], ...]) -> SessionIdentity:
        if provider.epoch == 1:
            connect_entered.set()
            await release_connect.wait()
        return await real_connect(tools=tools)

    monkeypatch.setattr(provider, "connect", delayed_connect)
    reconnect = asyncio.create_task(
        service.handle_event(
            ResponseCancelRejected(
                session_epoch=1,
                response_id="automatic-response",
                cancel_request_id="cancel-1",
                reason="no_active_response",
            )
        )
    )
    await asyncio.wait_for(connect_entered.wait(), timeout=0.2)
    await asyncio.sleep(0)

    clock.advance_to(GUARD_ALERT_DEADLINE_S + GUARD_CLEAR_ACK_DEADLINE_S)
    await asyncio.sleep(0)

    assert [kind for kind, _payload in telemetry_records].count("renderer_clear_unknown") == 1
    assert not reconnect.done()
    assert not service.playback_cleared(
        old_generation.utterance_id,
        old_generation.generation_epoch,
        100,
    )
    release_connect.set()
    await reconnect


@pytest.mark.asyncio
async def test_default_off_guard_switch_does_not_retire_missing_clear_ack() -> None:
    clock = VirtualClock()
    telemetry_records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            telemetry_records.append((kind, payload))

    service, _provider, _runtime, _frames = make_service(
        clock=clock,
        telemetry=_Telemetry(),
    )
    await service.connect()
    await start_audible_response(service, "automatic-response")
    old_generation = service.session.current_generation
    assert old_generation is not None
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="automatic-response",
            status="cancelled",
            reason="client_cancelled",
        )
    )
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="guard-response"))
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="guard-response",
            pcm=b"\x02\x03",
        )
    )
    await asyncio.sleep(0)

    clock.advance_to(GUARD_CLEAR_ACK_DEADLINE_S)
    await asyncio.sleep(0)

    assert not any(kind == "renderer_clear_unknown" for kind, _ in telemetry_records)
    assert service.playback_cleared(
        old_generation.utterance_id,
        old_generation.generation_epoch,
        100,
    )


@pytest.mark.asyncio
async def test_feature_on_ordinary_guard_alert_keeps_renderer_ack_authoritative() -> None:
    clock = VirtualClock()
    alerts: list[tuple[str | None, int | None]] = []
    telemetry_records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            telemetry_records.append((kind, payload))

    service, _provider, _runtime, _frames = make_service(
        clock=clock,
        alerts=alerts,
        telemetry=_Telemetry(),
        controlled_guard_reconnect=True,
    )
    await service.connect()
    await start_audible_response(service, "ordinary-response")
    old_generation = service.session.current_generation
    assert old_generation is not None
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await asyncio.sleep(0)

    clock.advance_to(GUARD_ALERT_DEADLINE_S)
    await asyncio.sleep(0)
    assert alerts == [(old_generation.utterance_id, old_generation.generation_epoch)]
    await asyncio.sleep(0)
    clock.advance_to(GUARD_ALERT_DEADLINE_S + GUARD_CLEAR_ACK_DEADLINE_S)
    await asyncio.sleep(0)

    assert not any(kind == "renderer_clear_unknown" for kind, _ in telemetry_records)
    assert service.playback_cleared(
        old_generation.utterance_id,
        old_generation.generation_epoch,
        100,
    )


@pytest.mark.asyncio
async def test_feature_on_ordinary_guard_switch_keeps_suggestion_retryable() -> None:
    clock = VirtualClock()
    telemetry_records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            telemetry_records.append((kind, payload))

    service, _provider, runtime, suggestion = await prepare_suggestion_response(
        clock=clock,
        telemetry=_Telemetry(),
        controlled_guard_reconnect=True,
    )
    old_generation = service.session.current_generation
    assert old_generation is not None
    event_id = f"suggestion:{suggestion.id}"
    assert service.session.host_event_is_deduplicated(event_id)
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await service.handle_event(
        ResponseStarted(session_epoch=1, response_id="ordinary-guard-response")
    )
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="ordinary-guard-response",
            pcm=b"\x02\x03",
        )
    )
    await asyncio.sleep(0)

    clock.advance_to(GUARD_CLEAR_ACK_DEADLINE_S)
    await asyncio.sleep(0)

    assert not any(kind == "renderer_clear_unknown" for kind, _ in telemetry_records)
    assert service.playback_cleared(
        old_generation.utterance_id,
        old_generation.generation_epoch,
        100,
    )
    assert not service.session.host_event_is_deduplicated(event_id)
    assert runtime.suggestions.get(suggestion.id).status == "pending"


@pytest.mark.asyncio
async def test_pre_audio_cancel_rejection_is_outside_controlled_reconnect_arm() -> None:
    clock = VirtualClock()
    alerts: list[tuple[str | None, int | None]] = []
    service, provider, _runtime, _frames = make_service(
        clock=clock,
        alerts=alerts,
        controlled_guard_reconnect=True,
    )
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="automatic-response"))
    assert service.session.current_generation is None
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()

    await service.handle_event(
        ResponseCancelRejected(
            session_epoch=1,
            response_id="automatic-response",
            cancel_request_id="cancel-1",
            reason="no_active_response",
        )
    )

    assert provider.epoch == 1
    assert provider.actions.count("close") == 0
    assert provider.response_intents == []
    await asyncio.sleep(0)
    clock.advance_to(GUARD_ALERT_DEADLINE_S)
    await asyncio.sleep(0)
    assert alerts == []


@pytest.mark.asyncio
async def test_guard_deadline_alerts_once_without_creating_before_terminal() -> None:
    clock = VirtualClock()
    alerts: list[tuple[str | None, int | None]] = []
    service, provider, _runtime, _frames = make_service(clock=clock, alerts=alerts)
    await service.connect()
    await start_audible_response(service, "assistant-active")
    generation = service.session.current_generation
    assert generation is not None
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)

    await service.flush_host_items()
    await asyncio.sleep(0)
    clock.advance_to(0.349)
    await asyncio.sleep(0)

    assert alerts == []
    assert provider.injected == []

    clock.advance_to(0.350)
    await asyncio.sleep(0)

    assert alerts == [(generation.utterance_id, generation.generation_epoch)]
    assert provider.injected == []
    clock.advance_to(1.0)
    await asyncio.sleep(0)
    assert alerts == [(generation.utterance_id, generation.generation_epoch)]


@pytest.mark.asyncio
async def test_guard_deadline_does_not_tone_after_local_onset_cleared_old_generation() -> None:
    clock = VirtualClock()
    alerts: list[tuple[str | None, int | None]] = []
    service, provider, _runtime, _frames = make_service(clock=clock, alerts=alerts)
    await service.connect()
    await start_audible_response(service, "assistant-active")
    generation = service.session.current_generation
    assert generation is not None
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await asyncio.sleep(0)
    assert await service.session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="assistant-active",
            status="cancelled",
            reason="client_cancelled",
        )
    )

    await service.local_speech_onset("local-onset")
    assert service.session.current_generation is None
    assert provider.actions[-1] == "clear:utterance-progress:1"
    clock.advance_to(GUARD_ALERT_DEADLINE_S)
    await asyncio.sleep(0)

    assert alerts == []


@pytest.mark.asyncio
async def test_local_onset_while_guard_waits_for_terminal_keeps_one_preemption() -> None:
    clock = VirtualClock()
    alerts: list[tuple[str | None, int | None]] = []
    telemetry_records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            telemetry_records.append((kind, payload))

    service, provider, _runtime, _frames = make_service(
        clock=clock,
        alerts=alerts,
        telemetry=_Telemetry(),
    )
    await service.connect()
    await start_audible_response(service, "assistant-active")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    original = service._guard_preemption
    assert original is not None

    await asyncio.sleep(0)
    clock.advance_to(GUARD_ALERT_DEADLINE_S)
    await asyncio.sleep(0)
    await service.local_speech_onset("local-noise")
    await service.flush_host_items()

    assert service._guard_preemption is not None
    assert service._guard_preemption.token == original.token
    assert provider.actions.count("cancel:assistant-active") == 1
    assert [kind for kind, _payload in telemetry_records].count("guard.preempt_started") == 1
    assert provider.injected == []

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="assistant-active",
            status="cancelled",
            reason="client_cancelled",
        )
    )

    assert provider.injected[-1].event_id == "guard-hit"


@pytest.mark.asyncio
async def test_guard_deadline_tone_only_during_prestart_provider_stall() -> None:
    clock = VirtualClock()
    alerts: list[tuple[str | None, int | None]] = []
    telemetry_records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            telemetry_records.append((kind, payload))

    service, provider, _runtime, _frames = make_service(
        clock=clock,
        alerts=alerts,
        telemetry=_Telemetry(),
    )
    await service.connect()
    await service.session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="ordinary-item",
            event_id="ordinary-event",
            content="ordinary response is waiting to start",
        )
    )
    creates_before = provider.actions.count("create_response")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)

    await service.flush_host_items()
    await asyncio.sleep(0)
    clock.advance_to(GUARD_ALERT_DEADLINE_S)
    await asyncio.sleep(0)

    assert alerts == [(None, None)]
    assert provider.actions.count("create_response") == creates_before
    assert provider.injected[-1].event_id == "ordinary-event"
    assert [queued.intent.item.event_id for queued in service._host_items] == ["guard-hit"]

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="ordinary-response"))
    assert provider.actions[-1] == "cancel:ordinary-response"
    assert [kind for kind, _payload in telemetry_records].count("provider.cancel_sent") == 1
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="ordinary-response",
            status="cancelled",
            reason="client_cancelled",
        )
    )

    assert provider.injected[-1].event_id == "guard-hit"
    assert provider.actions.count("create_response") == creates_before + 1
    assert [kind for kind, _payload in telemetry_records].count("provider.cancel_sent") == 1


@pytest.mark.asyncio
async def test_unrelated_response_start_does_not_bind_guard_cancel_telemetry() -> None:
    telemetry_records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            telemetry_records.append((kind, payload))

    service, provider, _runtime, _frames = make_service(telemetry=_Telemetry())
    await service.connect()
    await start_audible_response(service, "renderer-a")
    generation_a = service.session.current_generation
    assert generation_a is not None
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="renderer-a",
            status="completed",
            reason="completed",
        )
    )
    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="user-item", text="continue")
    )
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    preemption = service._guard_preemption
    assert preemption is not None
    assert preemption.old_response_id is None

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="unrelated-b"))

    assert service.session.provider_turn_phase("unrelated-b") == "active"
    assert "cancel:unrelated-b" not in provider.actions
    assert [kind for kind, _payload in telemetry_records].count("provider.cancel_sent") == 0


@pytest.mark.asyncio
async def test_session_fenced_prestart_response_binds_guard_cancel_telemetry() -> None:
    telemetry_records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            telemetry_records.append((kind, payload))

    service, provider, _runtime, _frames = make_service(telemetry=_Telemetry())
    await service.connect()
    await service.session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="ordinary-item",
            event_id="ordinary-event",
            content="ordinary response is waiting to start",
        )
    )
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    preemption = service._guard_preemption
    assert preemption is not None
    assert preemption.old_response_id is None

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="fenced-response"))

    preemption = service._guard_preemption
    assert preemption is not None
    assert preemption.old_response_id == "fenced-response"
    assert preemption.cancel_sent
    assert service.session.provider_turn_phase("fenced-response") == "cancel_requested"
    assert service.session.provider_turn_was_fenced("fenced-response")
    assert provider.actions.count("cancel:fenced-response") == 1
    assert [kind for kind, _payload in telemetry_records].count("provider.cancel_sent") == 1


@pytest.mark.asyncio
async def test_guard_premap_identity_keeps_slot_and_deadline_after_cancel_send() -> None:
    clock = VirtualClock()
    alerts: list[tuple[str | None, int | None]] = []
    service, provider, _runtime, _frames = make_service(clock=clock, alerts=alerts)
    await service.connect()
    await service.session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="ordinary-item",
            event_id="ordinary-event",
            content="ordinary response is waiting to start",
        )
    )
    creates_before = provider.actions.count("create_response")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await asyncio.sleep(0)

    clock.advance_to(0.100)
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="ordinary-response",
            pcm=b"\x00\x01",
        )
    )
    assert provider.actions[-1] == "cancel:ordinary-response"
    assert provider.actions.count("create_response") == creates_before

    clock.advance_to(GUARD_ALERT_DEADLINE_S)
    await asyncio.sleep(0)
    assert alerts == [(None, None)]
    assert provider.actions.count("create_response") == creates_before

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="ordinary-response",
            status="completed",
            reason="completed",
        )
    )
    assert provider.injected[-1].event_id == "guard-hit"
    assert provider.actions.count("create_response") == creates_before + 1


@pytest.mark.asyncio
async def test_guard_first_audio_before_deadline_disarms_alert() -> None:
    clock = VirtualClock()
    alerts: list[tuple[str | None, int | None]] = []
    service, provider, _runtime, _frames = make_service(clock=clock, alerts=alerts)
    await service.connect()
    await start_audible_response(service, "assistant-active")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="assistant-active",
            status="completed",
            reason="completed",
        )
    )
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="guard-response"))
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="guard-response",
            pcm=b"\x02\x03",
        )
    )
    await asyncio.sleep(0)

    clock.advance_to(0.350)
    await asyncio.sleep(0)

    assert alerts == []
    assert provider.injected[-1].event_id == "guard-hit"


@pytest.mark.asyncio
async def test_guard_premap_audio_disarms_when_late_start_opens_generation() -> None:
    clock = VirtualClock()
    alerts: list[tuple[str | None, int | None]] = []
    service, _provider, _runtime, _frames = make_service(clock=clock, alerts=alerts)
    await service.connect()
    await start_audible_response(service, "assistant-active")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="assistant-active",
            status="cancelled",
            reason="client_cancelled",
        )
    )

    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="guard-response",
            pcm=b"\x02\x03",
        )
    )
    assert service.session.current_generation is not None
    assert service.session.current_generation.response_id == "assistant-active"
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="guard-response"))
    assert service._guard_preemption is None
    await asyncio.sleep(0)
    clock.advance_to(GUARD_ALERT_DEADLINE_S)
    await asyncio.sleep(0)

    assert alerts == []
    assert service.session.current_generation is not None
    assert service.session.current_generation.response_id == "guard-response"


@pytest.mark.parametrize(
    ("status", "reason", "success"),
    [
        ("cancelled", "client_cancelled", True),
        ("cancelled", "server_cancelled", False),
        ("completed", "completed", False),
        ("failed", "provider_failed", False),
    ],
)
@pytest.mark.asyncio
async def test_guard_terminal_outcome_releases_slot_and_normalizes_cancel_truth(
    status: str,
    reason: str,
    success: bool,
) -> None:
    telemetry_records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            telemetry_records.append((kind, payload))

    service, provider, _runtime, _frames = make_service(telemetry=_Telemetry())
    await service.connect()
    await start_audible_response(service, "assistant-active")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="assistant-active",
            status=status,  # type: ignore[arg-type]
            reason=reason,
        )
    )

    assert provider.injected[-1].event_id == "guard-hit"
    terminal = next(
        payload for kind, payload in telemetry_records if kind == "provider.cancel_terminal"
    )
    assert terminal["success"] is success
    assert terminal["status"] == status


@pytest.mark.asyncio
async def test_guard_deadline_does_not_tone_after_old_audio_drains() -> None:
    clock = VirtualClock()
    alerts: list[tuple[str | None, int | None]] = []
    service, _provider, _runtime, _frames = make_service(clock=clock, alerts=alerts)
    await service.connect()
    await start_audible_response(service, "assistant-active")
    generation = service.session.current_generation
    assert generation is not None
    assert service.playback_started(generation.utterance_id, generation.generation_epoch)
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="assistant-active",
            status="completed",
            reason="completed",
        )
    )
    assert service.playback_done(generation.utterance_id, generation.generation_epoch, 20)
    await asyncio.sleep(0)

    clock.advance_to(GUARD_ALERT_DEADLINE_S)
    await asyncio.sleep(0)

    assert alerts == []


@pytest.mark.asyncio
async def test_guard_first_audio_wins_at_exact_deadline_boundary() -> None:
    clock = VirtualClock()
    alerts: list[tuple[str | None, int | None]] = []
    service, _provider, _runtime, _frames = make_service(clock=clock, alerts=alerts)
    await service.connect()
    await start_audible_response(service, "assistant-active")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await asyncio.sleep(0)
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="assistant-active",
            status="cancelled",
            reason="client_cancelled",
        )
    )
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="guard-response"))

    clock.advance_to(GUARD_ALERT_DEADLINE_S)
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="guard-response",
            pcm=b"\x02\x03",
        )
    )
    await asyncio.sleep(0)

    assert alerts == []
    assert service.session.current_generation is not None
    assert service.session.current_generation.response_id == "guard-response"


@pytest.mark.asyncio
async def test_guard_deadline_wins_at_exact_boundary_before_first_audio() -> None:
    clock = VirtualClock()
    alerts: list[tuple[str | None, int | None]] = []
    service, _provider, _runtime, _frames = make_service(clock=clock, alerts=alerts)
    await service.connect()
    await start_audible_response(service, "assistant-active")
    old_generation = service.session.current_generation
    assert old_generation is not None
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await asyncio.sleep(0)
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="assistant-active",
            status="cancelled",
            reason="client_cancelled",
        )
    )
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="guard-response"))

    clock.advance_to(GUARD_ALERT_DEADLINE_S)
    await asyncio.sleep(0)
    assert alerts == [(old_generation.utterance_id, old_generation.generation_epoch)]

    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="guard-response",
            pcm=b"\x02\x03",
        )
    )
    assert service.session.current_generation is not None
    assert service.session.current_generation.response_id == "guard-response"
    assert alerts == [(old_generation.utterance_id, old_generation.generation_epoch)]


@pytest.mark.parametrize("lifecycle", ["reconnect", "close"])
@pytest.mark.asyncio
async def test_guard_deadline_is_revoked_by_lifecycle(lifecycle: str) -> None:
    clock = VirtualClock()
    alerts: list[tuple[str | None, int | None]] = []
    service, _provider, _runtime, _frames = make_service(clock=clock, alerts=alerts)
    await service.connect()
    await start_audible_response(service, "assistant-active")
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    await asyncio.sleep(0)

    if lifecycle == "reconnect":
        await service._reconnect_provider_session()
    else:
        await service.close()
    clock.advance_to(GUARD_ALERT_DEADLINE_S)
    await asyncio.sleep(0)

    assert alerts == []


@pytest.mark.asyncio
async def test_non_preemptive_guard_events_do_not_cancel_assistant() -> None:
    service, provider, runtime, _frames = make_service(executor_names=("codex", "guard"))
    runtime.executors["guard"] = FakeExecutor("guard", ops=(WATCH_START,), priority=90)
    runtime.delegates.bind("d-progress", executor="guard", op="start")
    deadline = Deadline(delegate_id="d-deadline")
    runtime.delegates.terminate_with_deadline(
        deadline,
        executor="guard",
        op="start",
    )
    await service.connect()
    await start_audible_response(service, "assistant-active")

    service._queue_semantic_acknowledgement(
        _SemanticAcknowledgement(
            event_id="background:d-ack",
            summary="观察是否出现水杯",
            channel="guard",
        )
    )
    service.project_runtime_event(
        ProgressEvent(
            channel="guard",
            delegate_id="d-progress",
            op="start",
            phase="working",
            internal_activity=1,
            elapsed=1.0,
        )
    )
    miss = guard_handoff("d-miss", hit=False)
    project_claimed_handoff(service, runtime, miss)
    failed = guard_handoff("d-failed", outcome="failed")
    project_claimed_handoff(service, runtime, failed)
    service.project_runtime_event(deadline)

    await service.flush_host_items()

    assert len(service._host_items) == 4
    assert not any(
        queued.intent.item.event_id.startswith("progress:d-progress:")
        for queued in service._host_items
    )
    assert not any(queued.preemptive for queued in service._host_items)
    assert not any(action.startswith(("clear:", "cancel:")) for action in provider.actions)
    assert service.session.active_provider_response_id == "assistant-active"


@pytest.mark.asyncio
async def test_guard_hit_during_user_speaking_stays_pending_until_end_preempts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, provider, runtime, _frames = make_service(executor_names=("guard",))
    runtime.executors["guard"] = FakeExecutor("guard", priority=90)
    await service.connect()
    await start_audible_response(service, "assistant-active")
    host_preempt_calls = 0
    real_host_preempt = service.session.host_preempt

    async def spy_host_preempt() -> bool:
        nonlocal host_preempt_calls
        host_preempt_calls += 1
        return await real_host_preempt()

    monkeypatch.setattr(service.session, "host_preempt", spy_host_preempt)
    await service.handle_event(UserSpeechStarted(session_epoch=1, speech_id="user-1"))
    event = guard_handoff("d-guard")
    project_claimed_handoff(service, runtime, event)

    await service.flush_host_items()

    assert host_preempt_calls == 0
    assert not any(action.startswith(("clear:", "cancel:")) for action in provider.actions)
    assert [queued.intent.item.event_id for queued in service._host_items] == ["final:d-guard"]

    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="user-1"))

    assert host_preempt_calls == 1
    assert provider.actions[-1] == "cancel:assistant-active"
    assert not any(action.startswith("clear:") for action in provider.actions)
    assert [queued.intent.item.event_id for queued in service._host_items] == ["final:d-guard"]


@pytest.mark.asyncio
async def test_guard_hit_during_idle_user_speaking_flushes_first_on_end() -> None:
    service, provider, runtime, _frames = make_service(executor_names=("codex", "guard"))
    runtime.executors["guard"] = FakeExecutor("guard", priority=90)
    await service.connect()
    await service.handle_event(UserSpeechStarted(session_epoch=1, speech_id="user-1"))
    service._queue_host_item(host_fact("codex-old"), priority=50)
    event = guard_handoff("d-guard")
    project_claimed_handoff(service, runtime, event)

    await service.flush_host_items()

    assert not provider.injected
    assert not any(action.startswith("cancel:") for action in provider.actions)

    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="user-1"))

    assert provider.injected[0].event_id == "final:d-guard"
    assert not any(action.startswith("cancel:") for action in provider.actions)


@pytest.mark.asyncio
async def test_stale_user_hold_releases_before_urgent_preemption() -> None:
    clock = VirtualClock()
    service, provider, runtime, _frames = make_service(
        clock=clock,
        executor_names=("guard",),
    )
    runtime.executors["guard"] = FakeExecutor("guard", priority=90)
    await service.connect()
    await start_audible_response(service, "assistant-active")
    generation = service.session.current_generation
    assert generation is not None
    await service.handle_event(UserSpeechStarted(session_epoch=1, speech_id="lost-end"))
    clock.advance_to(31.0)

    event = guard_handoff("d-guard")
    project_claimed_handoff(service, runtime, event)
    await service.flush_host_items()

    assert provider.actions[-1] == "cancel:assistant-active"
    assert not any(action.startswith("clear:") for action in provider.actions)
    assert service.session.floor.state == "idle"
    assert [queued.intent.item.event_id for queued in service._host_items] == ["final:d-guard"]

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="assistant-active",
            status="cancelled",
            reason="host_preempted",
        )
    )

    assert [item.event_id for item in provider.injected] == ["final:d-guard"]
    assert [intent.item.event_id for intent in provider.response_intents] == ["final:d-guard"]
    assert service._host_items == []
    assert service.session.current_generation == generation


@pytest.mark.asyncio
async def test_guard_hit_before_response_started_stays_armed_then_cancels_first() -> None:
    service, provider, runtime, _frames = make_service(executor_names=("guard",))
    runtime.executors["guard"] = FakeExecutor("guard", priority=90)
    await service.connect()
    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="user-item", text="继续")
    )
    event = guard_handoff("d-guard")
    project_claimed_handoff(service, runtime, event)

    await service.flush_host_items()

    assert not provider.injected
    assert not any(action.startswith("cancel:") for action in provider.actions)

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="assistant-race"))

    assert provider.actions[-1] == "cancel:assistant-race"
    assert not provider.injected

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="assistant-race",
            status="cancelled",
            reason="host_preempted",
        )
    )

    assert provider.injected[-1].event_id == "final:d-guard"
    assert provider.actions.index("cancel:assistant-race") < provider.actions.index(
        "inject:final:final:d-guard"
    )


@pytest.mark.parametrize(
    ("priority", "expected_cancelled"),
    [(79, False), (80, True)],
    ids=("priority-79", "priority-80"),
)
@pytest.mark.asyncio
async def test_preemptive_priority_boundary(
    priority: int,
    expected_cancelled: bool,
) -> None:
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    await start_audible_response(service, f"assistant-{priority}")
    service._queue_host_item(
        host_fact(f"guard-{priority}"),
        priority=priority,
        preemptive=True,
    )

    await service.flush_host_items()

    assert any(action == f"cancel:assistant-{priority}" for action in provider.actions) is (
        expected_cancelled
    )


@pytest.mark.parametrize(("source", "effective"), [(90, 90), (100, 99), (999, 99)])
def test_host_queue_priority_is_capped_below_user_priority(source: int, effective: int) -> None:
    service, _provider, _runtime, _frames = make_service()

    service._queue_host_item(host_fact(f"priority-{source}"), priority=source, preemptive=True)

    queued = service._host_items[0]
    assert queued.priority == effective
    assert queued.sort_key[0] == -effective
    assert service._pending_preempt_priority == effective


async def prepare_two_continuation_batches(
    service: RealtimeService,
    provider: FakeProvider,
) -> None:
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    bridge.acceptance = {
        "call-1": acceptance_for(
            "call-1",
            event_id="event-tool-1",
            delegate_id="d-1",
            summary="任务一",
        ),
        "call-2": acceptance_for(
            "call-2",
            event_id="event-tool-2",
            delegate_id="d-2",
            summary="任务二",
        ),
    }
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="origin-1"))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "任务一", "origin_ref": "conversation:1"},
            response_id="origin-1",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="origin-1",
            status="completed",
            reason="completed",
        )
    )
    assert provider.actions.count("create_response") == 1

    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-2",
            item_id="item-2",
            name="codex__run",
            arguments={"work_order": "任务二", "origin_ref": "conversation:1"},
            response_id="origin-2",
        )
    )
    assert provider.actions.count("create_response") == 1


@pytest.mark.asyncio
async def test_guard_hit_is_delivered_before_second_ready_continuation() -> None:
    """Cancelling continuation one must not let continuation two overtake the armed hit."""
    service, provider, _runtime, _frames = make_service()
    await prepare_two_continuation_batches(service, provider)
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="continuation-1"))
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    assert provider.actions[-1] == "cancel:continuation-1"
    await service.flush_host_items()
    assert provider.actions.count("cancel:continuation-1") == 1

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="continuation-1",
            status="cancelled",
            reason="host_preempted",
        )
    )

    assert [item.event_id for item in provider.injected] == ["event-tool-1", "guard-hit"]
    assert [intent.kind for intent in provider.response_intents] == [
        "delegation_acknowledgement",
        "host_fact",
    ]

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="guard-response"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="guard-response",
            status="completed",
            reason="completed",
        )
    )

    assert [item.event_id for item in provider.injected] == [
        "event-tool-1",
        "guard-hit",
        "event-tool-2",
    ]
    assert [intent.kind for intent in provider.response_intents] == [
        "delegation_acknowledgement",
        "host_fact",
        "delegation_acknowledgement",
    ]


async def prepare_duplicate_guard_response(
    service: RealtimeService,
    provider: FakeProvider,
) -> None:
    await prepare_two_continuation_batches(service, provider)
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="continuation-1"))
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)

    await service.flush_host_items()
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="continuation-1",
            status="cancelled",
            reason="host_preempted",
        )
    )

    assert [item.event_id for item in provider.injected] == ["event-tool-1", "guard-hit"]
    assert len(service._host_items) == 1


@pytest.mark.asyncio
async def test_duplicate_guard_hit_consumption_redrives_second_continuation() -> None:
    """Consuming a deduplicated armed hit must immediately release ready continuation two."""
    service, provider, _runtime, _frames = make_service()
    await prepare_duplicate_guard_response(service, provider)
    service._delivery_ready.clear()

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="guard-response"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="guard-response",
            status="cancelled",
            reason="host_preempted",
        )
    )

    assert [item.event_id for item in provider.injected] == [
        "event-tool-1",
        "guard-hit",
        "event-tool-2",
    ]
    assert sum(item.event_id == "guard-hit" for item in provider.injected) == 1
    assert provider.actions.count("create_response") == 3
    assert not service._delivery_ready.is_set()


@pytest.mark.asyncio
async def test_fresh_guard_during_output_injection_blocks_continuation_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A hit queued while output injection awaits must win before continuation request."""
    service, provider, _runtime, _frames = make_service()
    await prepare_duplicate_guard_response(service, provider)
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="guard-response"))
    injection_started = asyncio.Event()
    release_injection = asyncio.Event()
    real_inject = provider.inject_host_item

    async def pausing_inject(item: HostContextItem) -> ItemIdentity:
        if item.event_id == "event-tool-2":
            injection_started.set()
            await release_injection.wait()
        return await real_inject(item)

    monkeypatch.setattr(provider, "inject_host_item", pausing_inject)
    urgent_terminal = asyncio.create_task(
        service.handle_event(
            ResponseTerminal(
                session_epoch=1,
                response_id="guard-response",
                status="cancelled",
                reason="host_preempted",
            )
        )
    )
    await asyncio.wait_for(injection_started.wait(), timeout=0.2)
    service._queue_host_item(host_fact("guard-fresh"), priority=90, preemptive=True)
    release_injection.set()
    await urgent_terminal

    assert [item.event_id for item in provider.injected] == [
        "event-tool-1",
        "guard-hit",
        "event-tool-2",
    ]
    assert provider.actions.count("create_response") == 2

    await service.flush_host_items()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="fresh-guard-response"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="fresh-guard-response",
            status="completed",
            reason="completed",
        )
    )

    assert provider.actions.count("create_response") == 4
    assert sum(intent.item.event_id == "event-tool-2" for intent in provider.response_intents) == 1


@pytest.mark.asyncio
async def test_user_speech_during_duplicate_delivery_blocks_continuation_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A floor claim during duplicate delivery must suppress the post-lock re-drive."""
    service, provider, _runtime, _frames = make_service()
    await prepare_duplicate_guard_response(service, provider)
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="guard-response"))
    duplicate_delivery_started = asyncio.Event()
    release_duplicate_delivery = asyncio.Event()
    real_deliver = service.session.deliver_preemptive_host_response

    async def pausing_duplicate_delivery(intent: HostResponseIntent) -> HostResponseDelivery:
        if intent.item.event_id == "guard-hit" and service.session.host_event_is_deduplicated(
            "guard-hit"
        ):
            duplicate_delivery_started.set()
            await release_duplicate_delivery.wait()
        return await real_deliver(intent)

    monkeypatch.setattr(
        service.session,
        "deliver_preemptive_host_response",
        pausing_duplicate_delivery,
    )
    service._delivery_ready.clear()
    urgent_terminal = asyncio.create_task(
        service.handle_event(
            ResponseTerminal(
                session_epoch=1,
                response_id="guard-response",
                status="cancelled",
                reason="host_preempted",
            )
        )
    )
    await asyncio.wait_for(duplicate_delivery_started.wait(), timeout=0.2)
    user_started = asyncio.create_task(
        service.handle_event(UserSpeechStarted(session_epoch=1, speech_id="user-race"))
    )
    for _ in range(50):
        if service.session.floor.state == "user_speaking":
            break
        await asyncio.sleep(0)
    assert service.session.floor.state == "user_speaking"
    release_duplicate_delivery.set()
    await asyncio.gather(urgent_terminal, user_started)

    assert provider.actions.count("create_response") == 2
    assert service.session.floor.state == "user_speaking"
    assert not service._delivery_ready.is_set()

    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="user-race"))

    assert provider.actions.count("create_response") == 3
    assert sum(item.event_id == "event-tool-2" for item in provider.injected) == 1
    assert sum(intent.item.event_id == "event-tool-2" for intent in provider.response_intents) == 1


@pytest.mark.asyncio
async def test_host_delivery_busy_race_keeps_delivery_loop_alive_and_retries_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    tool_output = HostContextItem.tool_output(
        host_item_id="host-race-tool",
        event_id="event-race-tool",
        call_id="call-race-tool",
        content='{"state":"ok"}',
    )
    continuation_intent = HostResponseIntent.tool_result(tool_output)
    assert await service.session.inject_tool_output(tool_output)
    create_entered = asyncio.Event()
    release_create = asyncio.Event()
    original_create_response = provider.create_response

    async def pausing_create_response(intent: HostResponseIntent) -> None:
        if intent.item.event_id == "event-race-tool":
            create_entered.set()
            await release_create.wait()
        await original_create_response(intent)

    monkeypatch.setattr(provider, "create_response", pausing_create_response)
    continuation = asyncio.create_task(
        service.session.request_tool_continuation((continuation_intent,))
    )
    await asyncio.wait_for(create_entered.wait(), timeout=0.2)
    service._queue_host_item(host_fact("host-after-race"), priority=50)
    delivery_loop = asyncio.create_task(service._delivery_loop())
    try:
        await asyncio.sleep(0)
        release_create.set()
        assert await continuation == "requested"
        for _ in range(10):
            await asyncio.sleep(0)

        assert not delivery_loop.done()
        assert [queued.intent.item.event_id for queued in service._host_items] == [
            "host-after-race"
        ]

        await service.handle_event(
            ResponseStarted(session_epoch=1, response_id="continuation-race")
        )
        await service.handle_event(
            ResponseTerminal(
                session_epoch=1,
                response_id="continuation-race",
                status="completed",
                reason="completed",
            )
        )

        assert sum(item.event_id == "host-after-race" for item in provider.injected) == 1
        assert (
            sum(intent.item.event_id == "host-after-race" for intent in provider.response_intents)
            == 1
        )
        assert not delivery_loop.done()
    finally:
        release_create.set()
        service._stop.set()
        service._delivery_ready.set()
        await asyncio.gather(continuation, delivery_loop, return_exceptions=True)


@pytest.mark.asyncio
async def test_preemptive_hit_beats_older_same_priority_heartbeat() -> None:
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    service._queue_host_item(host_fact("guard-heartbeat"), priority=90)
    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)

    await service.flush_host_items()

    assert provider.injected[0].event_id == "guard-hit"


@pytest.mark.asyncio
async def test_watch_hit_outranks_older_heartbeat_without_preempt_flag() -> None:
    """R113 kept the preemptive tiebreak out of ordinary watch hits; issue #50
    boosts a hit to HIT_ALERT_MIN_PRIORITY instead, so it now flushes ahead of
    a priority-40 heartbeat through explicit priority, still non-preemptive."""
    service, provider, runtime = make_full_chain_watch_service(routing_class="user_awaited")
    await service.connect()
    service._queue_host_item(host_fact("watch-heartbeat"), priority=40)

    runtime._process_event(
        HandoffEvent(
            channel="watch",
            delegate_id="d-watch",
            origin_ref="conversation:1",
            outcome="ok",
            trust="trusted_system",
            content={"hit": True, "observation": "桌面上出现水杯"},
        ),
        reclaim=True,
    )
    await service.flush_host_items()

    assert provider.injected[0].event_id == "final:d-watch"
    assert service._pending_preempt_priority is None


@pytest.mark.asyncio
async def test_same_class_fifo_delivers_older_host_fact_first() -> None:
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    service._queue_host_item(host_fact("first"), priority=50)
    service._queue_host_item(host_fact("second"), priority=50)

    await service.flush_host_items()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="first-response"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="first-response",
            status="completed",
            reason="completed",
        )
    )
    await service.flush_host_items()

    assert [item.event_id for item in provider.injected] == ["first", "second"]


@pytest.mark.asyncio
async def test_sync_announcement_uses_event_channel_priority_in_mixed_heap() -> None:
    service, provider, runtime, _frames = make_service(executor_names=("search", "codex"))
    runtime.executors["search"] = FakeExecutor("search", priority=40)
    runtime.executors["codex"] = FakeExecutor("codex", priority=50)
    await service.connect()
    search_event = search_handoff("d-search-priority")
    codex_event = HandoffEvent(
        channel="codex",
        delegate_id="d-codex-priority",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={"result": "codex result"},
    )

    service._queue_sync_announcement(search_event)
    service._queue_sync_announcement(codex_event)
    await service.flush_host_items()

    assert provider.injected[0].event_id == "sync:d-codex-priority"
    assert service._host_items[0].intent.item.event_id == "sync:d-search-priority"
    assert service._host_items[0].intent.item.content == service._sync_result_content(search_event)


@pytest.mark.asyncio
async def test_abandoned_sync_announcement_uses_accepted_executor_priority() -> None:
    service, provider, runtime, _frames = make_service(executor_names=("search", "codex"))
    runtime.executors["search"] = FakeExecutor("search", priority=40)
    runtime.executors["codex"] = FakeExecutor("codex", priority=50)
    await service.connect()
    acceptance = acceptance_for(
        "call-search-priority",
        event_id="event-search-priority",
        delegate_id="d-search-priority",
        summary="search priority",
        executor="search",
    )
    state = realtime_service._ToolCallState(
        acceptance=acceptance,
        provider_response_id="origin-search-priority",
        provider_session_epoch=1,
        origin_user_input_revision=0,
        observation="observed",
        dispatch="dispatched",
        sync="resolved",
    )

    service._announce_resolved_sync_state(state)
    service._queue_host_item(host_fact("codex-priority"), priority=50)
    await service.flush_host_items()

    assert provider.injected[0].event_id == "codex-priority"
    assert service._host_items[0].intent.item.event_id == "sync:d-search-priority"


@pytest.mark.asyncio
async def test_single_codex_progress_and_final_remain_fifo_within_same_priority() -> None:
    service, provider, runtime, _frames = make_service()
    await service.connect()

    assert runtime.observer is not None
    runtime.observer(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="working",
            internal_activity=1,
            elapsed=1.0,
        )
    )
    event = HandoffEvent(
        channel="codex",
        delegate_id="d-1",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={"result": "done"},
    )
    project_claimed_handoff(service, runtime, event, op="run")

    await service.flush_host_items()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="progress-response"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="progress-response",
            status="completed",
            reason="completed",
        )
    )
    await service.flush_host_items()

    assert [item.kind for item in provider.injected] == ["progress", "final"]


async def request_fallback_acknowledgement(
    service: RealtimeService,
    *,
    session_epoch: int,
) -> None:
    response_id = f"tool-response-{session_epoch}"
    await service.handle_event(
        ResponseStarted(session_epoch=session_epoch, response_id=response_id)
    )
    await service.handle_event(
        ToolCallReady(
            session_epoch=session_epoch,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id=response_id,
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=session_epoch,
            response_id=response_id,
            status="cancelled",
            reason="provider_turn_lost",
        )
    )


async def wait_for_stream_advance_without_service_stop(
    service: RealtimeService,
    advanced: asyncio.Event,
) -> None:
    advance_wait = asyncio.create_task(advanced.wait())
    stop_wait = asyncio.create_task(service.wait_stopped())
    done, pending = await asyncio.wait(
        {advance_wait, stop_wait},
        timeout=0.2,
        return_when=asyncio.FIRST_COMPLETED,
    )
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
    assert advance_wait in done, "service stopped before the provider event stream advanced"
    assert stop_wait not in done


def test_watch_working_heartbeat_updates_state_without_queueing_speech() -> None:
    service, _provider, runtime, _frames = make_service(executor_names=("codex", "watch"))
    runtime.executors["watch"] = FakeExecutor("water-scout")
    runtime.delegates.bind("d-watch", executor="watch", op="start")
    service.project_runtime_event(
        ProgressEvent(
            channel="watch",
            delegate_id="d-watch",
            op="start",
            phase="working",
            internal_activity=1,
            elapsed=5.0,
            summary="仍在寻找水杯",
        )
    )

    assert service._host_items == []
    assert service.session.snapshot().active_delegates[0][1].channel == "watch"


def _monitor_observation(
    *,
    channel: str = "guard",
    delegate_id: str = "d-guard",
    seq: int = 11,
    hit: bool = True,
) -> ObservationEvent:
    return ObservationEvent(
        channel=channel,
        delegate_id=delegate_id,
        op="start",
        origin_ref="conversation:1",
        trust="untrusted_external" if hit else "trusted_system",
        content=(
            {
                "state": "hit",
                "hit": True,
                "condition": "白纸",
                "observation": "画面中出现白纸",
                "hit_count": 1,
            }
            if hit
            else {"state": "cooling", "condition": "白纸", "hit_count": 1}
        ),
        seq=seq,
    )


def test_guard_observations_queue_unique_preemptive_hits_without_settling_delegate() -> None:
    service, _provider, runtime, _frames = make_service(executor_names=("guard",))
    runtime.executors["guard"] = FakeExecutor(
        "guard", ops=(WATCH_START,), priority=90, suggest=False
    )
    runtime.delegates.bind("d-guard", executor="guard", op="start")

    service.project_runtime_event(_monitor_observation(seq=11))
    service.project_runtime_event(_monitor_observation(seq=19))

    assert [item.intent.item.event_id for item in service._host_items] == [
        "observation:d-guard:11",
        "observation:d-guard:19",
    ]
    assert all(item.priority == 90 and item.preemptive for item in service._host_items)
    assert runtime.delegates.in_flight_delegate("d-guard") is not None
    assert service.session.delegate_state("d-guard") == "running"
    assert [item.intent.item.content for item in service._host_items] == [
        "检测到了：画面中出现白纸",
        "检测到了：画面中出现白纸",
    ]


def test_watch_hit_uses_current_visual_evidence_without_executor_jargon() -> None:
    service, _provider, runtime, _frames = make_service(executor_names=("watch",))
    runtime.executors["watch"] = FakeExecutor(
        "water-scout", ops=(WATCH_START,), priority=40, suggest=True
    )
    runtime.delegates.bind("d-guard", executor="watch", op="start")

    service.project_runtime_event(_monitor_observation(channel="watch"))

    assert [item.intent.item.content for item in service._host_items] == [
        "检测到了：画面中出现白纸"
    ]
    assert service._host_items[0].priority == 55
    assert service._host_items[0].preemptive is False


def test_guard_working_heartbeat_updates_state_without_queueing_speech() -> None:
    service, _provider, runtime, _frames = make_service(executor_names=("guard",))
    runtime.executors["guard"] = FakeExecutor(
        "guard", ops=(WATCH_START,), priority=90, suggest=False
    )
    runtime.delegates.bind("d-guard", executor="guard", op="start")

    service.project_runtime_event(
        ProgressEvent(
            channel="guard",
            delegate_id="d-guard",
            op="start",
            phase="working",
            internal_activity=13,
            elapsed=30.0,
            summary="仍在监控：看到水杯",
        )
    )

    assert service._host_items == []
    assert service.session.delegate_state("d-guard") == "running"


def test_monitor_lifecycle_and_late_observations_never_queue_host_items() -> None:
    service, _provider, runtime, _frames = make_service(executor_names=("guard",))
    runtime.executors["guard"] = FakeExecutor(
        "guard", ops=(WATCH_START,), priority=90, suggest=False
    )
    runtime.delegates.bind("d-guard", executor="guard", op="start")

    service.project_runtime_event(_monitor_observation(hit=False))
    assert service._host_items == []
    assert service.session.delegate_state("d-guard") == "running"

    runtime.delegates.settle("d-guard")
    service.project_runtime_event(_monitor_observation(seq=20))
    assert service._host_items == []


@pytest.mark.asyncio
async def test_guard_observation_identity_survives_reconnect_without_duplication() -> None:
    service, provider, runtime, _frames = make_service(executor_names=("guard",))
    runtime.executors["guard"] = FakeExecutor(
        "guard", ops=(WATCH_START,), priority=90, suggest=False
    )
    runtime.delegates.bind("d-guard", executor="guard", op="start")
    await service.connect()

    service.project_runtime_event(_monitor_observation(seq=11))
    await service._reconnect_provider_session()
    await service.flush_host_items()
    await complete_audible_response(service, "guard-first", session_epoch=2)
    service.project_runtime_event(_monitor_observation(seq=19))
    await service.flush_host_items()

    event_ids = [item.event_id for item in provider.injected]
    assert event_ids.count("observation:d-guard:11") == 1
    assert event_ids.count("observation:d-guard:19") == 1
    assert runtime.delegates.in_flight_delegate("d-guard") is not None


def test_mismatched_progress_is_not_projected() -> None:
    service, _provider, runtime, _frames = make_service(executor_names=("watch",))
    runtime.delegates.bind("d-watch", executor="watch", op="start")

    service.project_runtime_event(
        ProgressEvent(
            channel="watch",
            delegate_id="d-watch",
            op="task",
            phase="working",
            internal_activity=1,
            elapsed=5.0,
            summary="wrong op",
        )
    )

    assert not service._host_items


def test_channel_mismatched_progress_is_not_projected() -> None:
    service, _provider, runtime, _frames = make_service(executor_names=("watch", "guard"))
    runtime.delegates.bind("d-watch", executor="watch", op="start")

    service.project_runtime_event(
        ProgressEvent(
            channel="guard",
            delegate_id="d-watch",
            op="start",
            phase="working",
            internal_activity=1,
            elapsed=5.0,
            summary="wrong channel",
        )
    )

    assert not service._host_items


def test_settled_delegate_progress_is_not_projected() -> None:
    service, _provider, runtime, _frames = make_service(executor_names=("watch",))
    runtime.delegates.bind("d-watch", executor="watch", op="start")
    runtime.delegates.settle("d-watch")

    service.project_runtime_event(
        ProgressEvent(
            channel="watch",
            delegate_id="d-watch",
            op="start",
            phase="working",
            internal_activity=1,
            elapsed=5.0,
            summary="late progress",
        )
    )

    assert not service._host_items


def test_non_codex_handoff_projects_generic_final_and_records_channel() -> None:
    service, _provider, runtime, _frames = make_service(executor_names=("watch",))
    runtime.executors["watch"] = FakeExecutor("water-scout")

    event = HandoffEvent(
        channel="watch",
        delegate_id="d-watch",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={
            "observation": "桌面上出现蓝色水杯",
            "media_ref": "cam:1",
            "detail": {"path": "/secret/file"},
        },
    )
    project_claimed_handoff(service, runtime, event)

    queued = service._host_items[0]
    assert queued.intent.item.content == "water-scout 报告：桌面上出现蓝色水杯"
    assert "cam:1" not in queued.intent.item.content
    assert service.session._delegates["d-watch"].channel == "watch"


def test_non_sync_deadline_projects_once_after_runtime_settlement() -> None:
    """A generic timeout is shown only for the Deadline that settled its delegate."""
    service, _provider, runtime, _frames = make_service(executor_names=("watch",))
    runtime.executors["watch"] = FakeExecutor("water-scout", ops=(WATCH_START,), priority=73)
    deadline = Deadline(delegate_id="d-watch")
    runtime.delegates.terminate_with_deadline(deadline, executor="watch", op="start")

    service.project_runtime_event(deadline)
    service.project_runtime_event(Deadline(delegate_id="d-watch"))

    assert [queued.intent.item.content for queued in service._host_items] == [
        "water-scout 的委派任务超时，未能确认结果。"
    ]
    assert "后台" not in service._host_items[0].intent.item.content
    assert service._host_items[0].priority == 73


@pytest.mark.asyncio
async def test_deadline_settles_session_progress_recovery_and_codex_state() -> None:
    states: list[str] = []
    service, provider, runtime, _frames = make_service(on_codex_state=states.append)
    runtime.executors["codex"] = FakeExecutor(
        "codex",
        ops=(WATCH_START,),
        priority=50,
    )
    runtime.delegates.bind("d-deadline", executor="codex", op="start")
    await service.connect()
    service.project_runtime_event(
        ProgressEvent(
            channel="codex",
            delegate_id="d-deadline",
            op="start",
            phase="working",
            internal_activity=3,
            elapsed=12.0,
            summary="已完成三步",
        )
    )
    deadline = Deadline(delegate_id="d-deadline")
    runtime.delegates.terminate_with_deadline(
        deadline,
        executor="codex",
        op="start",
    )

    service.project_runtime_event(deadline)

    assert service.session.delegate_state("d-deadline") == "unknown"
    record = service.session._delegates["d-deadline"]
    assert record.state == "unknown"
    assert record.progress_summary is None
    assert record.internal_activity == 0
    assert record.elapsed == 0.0
    assert "d-deadline" not in service._last_progress_summary
    assert states == ["running", "idle"]
    assert service.codex_state == "idle"
    assert [queued.intent.item.event_id for queued in service._host_items] == [
        "progress:d-deadline:working:3",
        "deadline:d-deadline",
    ]

    await service.session.reconnect(tools=())

    recovery = provider.injected[-1]
    assert recovery.kind == "recovery"
    assert "active_work_count=0" in recovery.content
    assert "已完成三步" not in recovery.content


@pytest.mark.asyncio
async def test_unhashable_progress_channel_is_rejected_without_observer_failure() -> None:
    runtime = Runtime(clock=VirtualClock(), memory=Memory())
    service, _provider, assembled_runtime, _frames = make_service(runtime=runtime)
    assert assembled_runtime is runtime
    await service.connect()
    malformed = ProgressEvent(
        channel=["codex"],  # type: ignore[arg-type]
        delegate_id="d-malformed",
        op="run",
        phase="working",
        internal_activity=1,
        elapsed=1.0,
    )

    runtime._process_event(malformed, reclaim=True)

    assert runtime.applied[-1] is malformed
    assert service._host_items == []


def test_sync_deadline_is_consumed_without_generic_projection() -> None:
    """R105 timeouts retain their pending-tool-result path, never a timeout host fact."""
    service, _provider, _runtime, _frames = make_service()
    item = HostContextItem.tool_output(
        host_item_id="host-status",
        event_id="event-status",
        call_id="call-status",
        content='{"state":"pending"}',
    )
    acceptance = ToolAcceptance(
        accepted=True,
        code="accepted",
        delegate_id="d-status",
        host_item=item,
        response_intent=HostResponseIntent.tool_result(item),
        sync_result=True,
        executor="codex",
    )
    service._tool_calls[(1, "call-status")] = realtime_service._ToolCallState(
        acceptance=acceptance,
        provider_response_id="status-response",
        provider_session_epoch=1,
        origin_user_input_revision=0,
        observation="observed",
        dispatch="dispatched",
        sync="pending",
    )
    service._pending_sync["d-status"] = (1, "call-status")

    assert service._expire_sync_result(Deadline(delegate_id="d-status")) is True
    assert not service._host_items


@pytest.mark.asyncio
async def test_watch_ack_uses_manifest_identity_and_priority_not_tool_prefix() -> None:
    """A delegated non-Codex tool must keep its executor's acknowledgement contract."""
    service, _provider, runtime, _frames = make_service(executor_names=("watch",))
    runtime.executors["watch"] = FakeExecutor("water-scout", ops=(WATCH_START,), priority=73)
    service._tools = CompiledTools(
        schemas=(),
        bindings={
            "monitor__start": ToolBinding(
                kind="delegate",
                logical_name="watch.start",
                executor="watch",
                op="start",
            )
        },
    )
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    bridge.acceptance = acceptance_for(
        "call-watch",
        event_id="event-watch",
        delegate_id="d-watch",
        summary="出现水杯",
        executor="watch",
    )
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="watch-response"))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-watch",
            item_id="item-watch",
            name="monitor__start",
            arguments={"condition": "出现水杯", "origin_ref": "conversation:1"},
            response_id="watch-response",
        )
    )
    await service.handle_event(UserSpeechStarted(session_epoch=1, speech_id="watch-speech"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="watch-response",
            status="cancelled",
            reason="provider_turn_lost",
        )
    )

    queued = service._host_items[0]
    assert queued.intent.item.content == "water-scout 已提交，正在启动：出现水杯"
    assert "后台" not in queued.intent.item.content
    assert queued.priority == 73


@pytest.mark.parametrize(
    "display_name, outcome, content, expected",
    [
        (
            "guard",
            "ok",
            {
                "hit": True,
                "condition": "出现水杯",
                "observation": "桌面上出现蓝色水杯",
                "media_ref": "cam:1",
            },
            "guard 报告命中出现水杯：桌面上出现蓝色水杯",
        ),
        (
            "watch",
            "ok",
            {"hit": False, "reason": "window_elapsed"},
            "watch 监控结束，未命中条件",
        ),
        (
            "watch",
            "ok",
            {"message": "任务已停止", "path": "/secret/file"},
            "watch 报告：任务已停止",
        ),
        (
            "watch",
            "unknown",
            {"error": "capture_unavailable"},
            "watch 任务结果不确定（capture_unavailable）",
        ),
    ],
)
def test_generic_final_speech_view_extracts_prose_without_envelope(
    display_name: str,
    outcome: str,
    content: object,
    expected: str,
) -> None:
    final_view = getattr(realtime_service, "_generic_final_speech_view", lambda *_args: "")
    assert final_view(display_name, outcome, content) == expected


@pytest.mark.asyncio
async def test_realtime_trace_is_opt_in_and_redacts_sensitive_event_data(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.delenv("NOVA_AUDIO_AGENT_REALTIME_TRACE", raising=False)
    default_service, _provider, _runtime, _frames = make_service()
    monkeypatch.setenv("NOVA_AUDIO_AGENT_REALTIME_TRACE", "1")
    await default_service.connect()
    await default_service.handle_event(
        UserSpeechStarted(session_epoch=1, speech_id="speech-default-silent")
    )
    assert "[realtime-trace]" not in capsys.readouterr().out

    api_key = "trace-secret-api-key"
    work_order = "trace-secret-work-order"
    function_output = "trace-secret-function-output"
    call_id = "call-identifier-that-must-be-shortened"
    response_id = "response-identifier-that-must-be-shortened"
    monkeypatch.setenv("DASHSCOPE_API_KEY", api_key)
    traced_service, _provider, _runtime, _frames = make_service()
    monkeypatch.delenv("NOVA_AUDIO_AGENT_REALTIME_TRACE")
    bridge = traced_service._bridge
    assert isinstance(bridge, FakeBridge)
    host_item = HostContextItem.tool_output(
        host_item_id="host-trace",
        event_id="event-trace",
        call_id=call_id,
        content=function_output,
    )
    bridge.acceptance = ToolAcceptance(
        accepted=True,
        code="accepted",
        delegate_id="delegate-trace",
        host_item=host_item,
        response_intent=HostResponseIntent.delegation_acknowledgement(
            item=host_item,
            task_summary=work_order,
        ),
        executor="codex",
    )
    await traced_service.connect()
    await traced_service.handle_event(ResponseStarted(session_epoch=1, response_id=response_id))
    capsys.readouterr()

    await traced_service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id=call_id,
            item_id="item-trace",
            name="codex__run",
            arguments={"work_order": work_order, "api_key": api_key},
            response_id=response_id,
        )
    )

    output = capsys.readouterr().out
    assert "[realtime-trace]" in output
    assert "event=ToolCallReady" in output
    assert "epoch=1" in output
    assert "response=response" in output
    assert "call=call-ide" in output
    assert "provider_phase=active" in output
    assert "batch_phase=collecting" in output
    assert "tool_output=pending" in output
    assert "continuation=queued" in output
    assert "active_provider=response" in output
    assert "renderer_response=-" in output
    assert "renderer_generation=-" in output
    assert "floor=idle" in output
    assert "continuation_queue=1" in output
    assert "host_queue=0" in output
    assert call_id not in output
    assert response_id not in output
    assert work_order not in output
    assert function_output not in output
    assert api_key not in output


@pytest.mark.asyncio
async def test_realtime_trace_correlates_continuation_lifecycle(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("NOVA_AUDIO_AGENT_REALTIME_TRACE", "1")
    service, _provider, _runtime, _frames = make_service()
    await service.connect()
    origin_response_id = "origin-response"
    continuation_response_id = "continuation-response"
    await service.handle_event(ResponseStarted(session_epoch=1, response_id=origin_response_id))
    capsys.readouterr()
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id=origin_response_id,
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id=origin_response_id,
            status="completed",
            reason="completed",
        )
    )
    requested = capsys.readouterr().out.splitlines()[-1]
    assert "event=ResponseTerminal" in requested
    assert "batch_phase=requested" in requested

    await service.handle_event(
        ResponseStarted(session_epoch=1, response_id=continuation_response_id)
    )
    bound = capsys.readouterr().out.strip()
    assert "event=ResponseStarted" in bound
    assert "batch_phase=bound" in bound
    assert "tool_output=confirmed" in bound
    assert "continuation=bound" in bound

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id=continuation_response_id,
            status="completed",
            reason="completed",
        )
    )
    terminal = capsys.readouterr().out.strip()
    assert "event=ResponseTerminal" in terminal
    assert "batch_phase=terminal" in terminal
    assert "tool_output=confirmed" in terminal
    assert "continuation=terminal" in terminal


@pytest.mark.asyncio
async def test_realtime_trace_records_local_speech_onset_transition(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Local onset must be visible in the trace: it is a floor/renderer write point."""
    monkeypatch.setenv("NOVA_AUDIO_AGENT_REALTIME_TRACE", "1")
    service, _provider, _runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(
        UserSpeechStarted(session_epoch=1, speech_id="speech-provider-identifier")
    )
    capsys.readouterr()

    await service.local_speech_onset("speech-local-identifier")

    output = capsys.readouterr().out
    assert "[realtime-trace]" in output
    assert "event=LocalSpeechOnset" in output
    assert "speech-local" not in output
    assert "floor_before=user_speaking" in output

    await service.local_speech_onset("秘密 payload!")
    onset_line = capsys.readouterr().out
    assert "秘密" not in onset_line
    assert "payload" not in onset_line

    await service.local_speech_onset("秘密 payload!")
    repeat_line = capsys.readouterr().out
    first_alias = next(field for field in onset_line.split() if field.startswith("speech="))
    assert first_alias in repeat_line


def acceptance_for(
    call_id: str,
    *,
    event_id: str,
    delegate_id: str,
    summary: str,
    executor: str | None = "codex",
) -> ToolAcceptance:
    item = HostContextItem.tool_output(
        host_item_id=f"host-{event_id}",
        event_id=event_id,
        call_id=call_id,
        content='{"state":"accepted"}',
    )
    return ToolAcceptance(
        accepted=True,
        code="accepted",
        delegate_id=delegate_id,
        host_item=item,
        response_intent=HostResponseIntent.delegation_acknowledgement(
            item=item,
            task_summary=summary,
        ),
        executor=executor,
    )


@pytest.mark.asyncio
async def test_non_codex_delegate_registers_at_acceptance_before_progress() -> None:
    """An accepted background delegate survives until its first runtime event."""
    states: list[str] = []
    telemetry_records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            telemetry_records.append((kind, payload))

    service, _provider, runtime, _frames = make_service(
        on_codex_state=states.append,
        telemetry=_Telemetry(),
        executor_names=("watch",),
    )
    service._tools = CompiledTools(
        schemas=(),
        bindings={
            "watch__start": ToolBinding(
                kind="delegate",
                logical_name="watch.start",
                executor="watch",
                op="start",
            )
        },
    )
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    bridge.acceptance = acceptance_for(
        "call-watch",
        event_id="event-watch",
        delegate_id="d-watch",
        summary="观察是否出现水杯",
        executor="watch",
    )
    watch_tool_call = ToolCallReady(
        session_epoch=1,
        call_id="call-watch",
        item_id="item-watch",
        name="watch__start",
        arguments={"condition": "出现水杯", "origin_ref": "conversation:1"},
        response_id="response-watch",
    )
    await service.connect()

    await service.handle_event(watch_tool_call)

    record = dict(service.session.snapshot().active_delegates)["d-watch"]
    assert record.channel == "watch"
    assert record.summary == "观察是否出现水杯"
    assert record.state == "running"
    assert states == []
    assert [kind for kind, _payload in telemetry_records if kind.startswith("codex.")] == []

    assert isinstance(runtime, FakeRuntime)
    runtime.delegates.bind("d-watch", executor="watch", op="start")
    service.project_runtime_event(
        ProgressEvent(
            channel="watch",
            delegate_id="d-watch",
            op="start",
            phase="working",
            internal_activity=1,
            elapsed=5.0,
            summary="仍在观察水杯",
        )
    )

    record = dict(service.session.snapshot().active_delegates)["d-watch"]
    assert record.summary == "观察是否出现水杯"
    assert record.channel == "watch"
    assert record.progress_summary == "仍在观察水杯"
    assert states == []
    assert [kind for kind, _payload in telemetry_records if kind.startswith("codex.")] == []


@pytest.mark.asyncio
async def test_reconnect_before_non_codex_progress_recovers_accepted_delegate() -> None:
    """Recovery lists accepted work even if the executor has not emitted progress."""
    service, provider, _runtime, _frames = make_service(executor_names=("watch",))
    service._tools = CompiledTools(
        schemas=(),
        bindings={
            "watch__start": ToolBinding(
                kind="delegate",
                logical_name="watch.start",
                executor="watch",
                op="start",
            )
        },
    )
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    bridge.acceptance = acceptance_for(
        "call-watch",
        event_id="event-watch",
        delegate_id="d-watch",
        summary="观察是否出现水杯",
        executor="watch",
    )
    watch_tool_call = ToolCallReady(
        session_epoch=1,
        call_id="call-watch",
        item_id="item-watch",
        name="watch__start",
        arguments={"condition": "出现水杯", "origin_ref": "conversation:1"},
        response_id="response-watch",
    )
    await service.connect()

    await service.handle_event(watch_tool_call)
    await service.session.reconnect(tools=())

    recovery = provider.injected[-1]
    assert recovery.kind == "recovery"
    assert "active_work_count=1" in recovery.content
    assert "观察是否出现水杯" in recovery.content


@pytest.mark.asyncio
async def test_codex_acceptance_preserves_summary_and_dispatch_telemetry() -> None:
    """Codex retains the semantic acknowledgement and its dispatch signal."""
    telemetry_records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            telemetry_records.append((kind, payload))

    service, _provider, _runtime, _frames = make_service(telemetry=_Telemetry())
    await service.connect()

    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "原始参数不应覆盖摘要", "origin_ref": "conversation:1"},
            response_id="response-1",
        )
    )

    record = dict(service.session.snapshot().active_delegates)["d-1"]
    assert record.summary == "实现俄罗斯方块"
    assert record.channel == "codex"
    assert record.state == "running"
    assert ("codex.dispatch", {"delegate_id": "d-1"}) in telemetry_records


@pytest.mark.asyncio
async def test_missing_semantic_summary_uses_bounded_manifest_display_name_fallback() -> None:
    """A missing response-intent summary cannot create an unbounded recovery record."""
    display_name = "监" * 250
    service, _provider, runtime, _frames = make_service(executor_names=("watch",))
    assert isinstance(runtime, FakeRuntime)
    runtime.executors["watch"] = FakeExecutor(display_name)
    accepted = acceptance_for(
        "call-watch",
        event_id="event-watch",
        delegate_id="d-watch",
        summary="fallback source",
        executor="watch",
    )
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    bridge.acceptance = ToolAcceptance(
        accepted=True,
        code="accepted",
        delegate_id="d-watch",
        host_item=accepted.host_item,
        response_intent=HostResponseIntent.tool_result(accepted.host_item),
        executor="watch",
    )
    await service.connect()

    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-watch",
            item_id="item-watch",
            name="watch__missing_summary",
            arguments={"condition": "出现水杯", "origin_ref": "conversation:1"},
            response_id="response-watch",
        )
    )

    record = dict(service.session.snapshot().active_delegates)["d-watch"]
    assert record.summary == "监" * 240
    assert len(record.summary) == 240


@pytest.mark.asyncio
async def test_codex_state_tracks_all_active_delegates_without_duplicates() -> None:
    states: list[str] = []
    service, _provider, _runtime, _frames = make_service(on_codex_state=states.append)
    await service.connect()

    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现游戏", "origin_ref": "conversation:1"},
            response_id="response-1",
        )
    )
    for delegate_id in ("d-1", "d-2"):
        service.project_runtime_event(
            ProgressEvent(
                channel="codex",
                delegate_id=delegate_id,
                op="run",
                phase="working",
                internal_activity=1,
                elapsed=0.5,
            )
        )
    first = HandoffEvent(
        channel="codex",
        delegate_id="d-1",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={"result": "first complete"},
    )
    project_claimed_handoff(service, _runtime, first, op="run")
    assert states == ["running"]
    assert service.codex_state == "running"

    second = HandoffEvent(
        channel="codex",
        delegate_id="d-2",
        origin_ref="conversation:1",
        outcome="failed",
        trust="trusted_system",
        content={"error": "cancelled"},
    )
    project_claimed_handoff(service, _runtime, second, op="run")
    assert states == ["running", "idle"]
    assert service.codex_state == "idle"


@pytest.mark.asyncio
async def test_codex_state_sink_failure_does_not_reject_delegate() -> None:
    def fail(_state: str) -> None:
        raise RuntimeError("desktop unavailable")

    service, _provider, _runtime, _frames = make_service(on_codex_state=fail)
    await service.connect()
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现游戏", "origin_ref": "conversation:1"},
            response_id="response-1",
        )
    )

    assert service.session.delegate_state("d-1") == "running"
    assert service.codex_state == "running"


@pytest.mark.asyncio
async def test_codex_state_ignores_accepted_non_codex_delegate_and_unknown_handoff() -> None:
    """Codex state remains channel-filtered after a non-Codex acceptance."""
    states: list[str] = []
    service, _provider, _runtime, _frames = make_service(
        on_codex_state=states.append,
        executor_names=("search",),
    )
    service._tools = CompiledTools(
        schemas=(),
        bindings={
            "search__search": ToolBinding(
                kind="delegate",
                logical_name="search.search",
                executor="search",
                op="search",
            )
        },
    )
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    bridge.acceptance = acceptance_for(
        "call-search",
        event_id="event-search",
        delegate_id="d-search",
        summary="查询天气",
        executor="search",
    )
    await service.connect()

    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-search",
            item_id="item-search",
            name="search__search",
            arguments={"query": "天气", "origin_ref": "conversation:1"},
            response_id="response-1",
        )
    )
    service.project_runtime_event(
        HandoffEvent(
            channel="search",
            delegate_id="d-unknown",
            origin_ref="conversation:1",
            outcome="ok",
            trust="trusted_system",
            content={"result": "晴天"},
        )
    )

    assert states == []
    record = dict(service.session.snapshot().active_delegates)["d-search"]
    assert record.channel == "search"
    assert record.summary == "查询天气"
    assert service.codex_state == "idle"
    assert len(service._host_items) == 0


@pytest.mark.asyncio
async def test_tool_output_confirms_before_floor_clears_then_continuation_requests() -> None:
    """Output confirmation ignores the floor, but the continuation waits for
    both the floor and the renderer (#49)."""
    service, provider, _runtime, frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="tool-response",
            pcm=b"\x00\x01",
        )
    )
    await service.handle_event(UserSpeechStarted(session_epoch=1, speech_id="speech-overlap"))

    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )

    assert service.session.delegate_state("d-1") == "running"
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    assert len(bridge.calls) == 1
    assert provider.injected == []
    assert provider.response_intents == []
    original_generation = service.session.current_generation
    assert original_generation is not None
    assert frames[-1].pcm == b"\x00\x01"

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="completed",
            reason="completed",
        )
    )

    assert provider.injected == [
        HostContextItem.tool_output(
            host_item_id="host-tool",
            event_id="event-tool",
            call_id="call-1",
            content='{"state":"accepted"}',
        )
    ]
    assert len(bridge.calls) == 1
    assert provider.actions[-1] == "inject:tool_output:event-tool"
    assert provider.response_intents == []
    assert service.session.current_generation == original_generation
    assert service.session.foreground_idle is False
    assert service.session.floor.state == "user_speaking"

    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="speech-overlap"))

    # #49: the floor cleared but the renderer is still audible — the
    # continuation keeps waiting for playback to finish.
    assert provider.actions[-1] == "inject:tool_output:event-tool"
    assert provider.response_intents == []
    assert service.session.current_generation == original_generation
    assert service.session.floor.state == "idle"

    assert service.playback_done(
        original_generation.utterance_id, original_generation.generation_epoch
    )
    await service._drive_continuations()

    assert provider.actions[-1] == "create_response"
    assert provider.response_intents[-1].kind == "delegation_acknowledgement"
    assert service.session.foreground_idle is False
    assert service.session.floor.state == "idle"


@pytest.mark.asyncio
async def test_replayed_tool_call_is_not_redispatched_or_reacknowledged() -> None:
    """A repeated provider event must not create a second delegate or acceptance response."""
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    event = ToolCallReady(
        session_epoch=1,
        call_id="call-1",
        item_id="item-1",
        name="codex__run",
        arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
        response_id="tool-response",
    )

    await service.handle_event(event)
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    replayed_output = HostContextItem.tool_output(
        host_item_id="host-tool-replayed",
        event_id="event-tool-replayed",
        call_id="call-1",
        content='{"state":"accepted"}',
    )
    bridge.acceptance = ToolAcceptance(
        accepted=True,
        code="accepted",
        delegate_id="d-replayed",
        host_item=replayed_output,
        response_intent=HostResponseIntent.delegation_acknowledgement(
            item=replayed_output,
            task_summary="实现俄罗斯方块",
        ),
        executor="codex",
    )
    await service.handle_event(event)

    assert provider.injected == []
    assert len(bridge.calls) == 1

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="completed",
            reason="completed",
        )
    )

    assert provider.injected == [
        HostContextItem.tool_output(
            host_item_id="host-tool",
            event_id="event-tool",
            call_id="call-1",
            content='{"state":"accepted"}',
        )
    ]
    assert provider.actions.count("create_response") == 1


@pytest.mark.asyncio
async def test_multiple_calls_share_one_ordered_continuation_batch() -> None:
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    bridge.acceptance = {
        "call-1": acceptance_for(
            "call-1",
            event_id="event-tool-1",
            delegate_id="d-1",
            summary="任务一",
        ),
        "call-2": acceptance_for(
            "call-2",
            event_id="event-tool-2",
            delegate_id="d-2",
            summary="任务二",
        ),
    }
    calls = (
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "任务一", "origin_ref": "conversation:1"},
            response_id="tool-response",
        ),
        ToolCallReady(
            session_epoch=1,
            call_id="call-2",
            item_id="item-2",
            name="codex__run",
            arguments={"work_order": "任务二", "origin_ref": "conversation:1"},
            response_id="tool-response",
        ),
    )

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    for call in calls:
        await service.handle_event(call)
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="completed",
            reason="completed",
        )
    )

    assert [item.call_id for item in provider.injected] == ["call-1", "call-2"]
    assert provider.actions.count("create_response") == 1
    assert [intent.item.call_id for intent in provider.response_intents] == ["call-1"]

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="continuation-1"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="continuation-1",
            status="completed",
            reason="completed",
        )
    )

    for call in calls:
        state = service._tool_calls[(1, call.call_id)]
        assert state.continuation == "terminal"
        assert state.final_disposition == "completed"
    bridge_calls = len(bridge.calls)
    injections = len(provider.injected)
    responses = provider.actions.count("create_response")
    for call in calls:
        await service.handle_event(call)
    assert len(bridge.calls) == bridge_calls
    assert len(provider.injected) == injections
    assert provider.actions.count("create_response") == responses


@pytest.mark.asyncio
async def test_explicit_origin_mismatch_is_not_dispatched_or_advanced() -> None:
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="response-a"))

    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-b",
            item_id="item-b",
            name="codex__run",
            arguments={"work_order": "任务 B", "origin_ref": "conversation:1"},
            response_id="response-b",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-a",
            status="completed",
            reason="completed",
        )
    )

    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    assert bridge.calls == []
    assert len(provider.injected) == 1
    assert provider.injected[0].call_id == "call-b"
    assert provider.injected[0].content == '{"state":"superseded"}'
    assert provider.actions.count("create_response") == 0
    state = service._tool_calls[(1, "call-b")]
    assert state.observation == "superseded"
    assert state.dispatch == "not_dispatched"
    assert state.final_disposition == "superseded"


@pytest.mark.asyncio
async def test_tool_ready_and_barge_in_preserve_dispatched_delegate_without_continuation() -> None:
    """Cancelling the origin must close its call without orphaning accepted work."""
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )

    await service.handle_event(
        UserSpeechStarted(session_epoch=1, speech_id="speech-user", provider_item_id="user-item")
    )
    await service.local_speech_onset("speech-local-uuid")

    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    assert len(bridge.calls) == 1
    assert service.session.delegate_state("d-1") == "running"
    assert provider.injected == []

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="cancelled",
            reason="turn_detected",
        )
    )

    assert provider.injected == [
        HostContextItem.tool_output(
            host_item_id="host-tool",
            event_id="event-tool",
            call_id="call-1",
            content='{"state":"accepted"}',
        )
    ]
    assert provider.actions.count("create_response") == 0
    assert len(service._host_items) == 1
    queued = service._host_items[0].intent
    assert queued.kind == "host_fact"
    assert queued.item.kind == "progress"
    assert queued.item.content == "Codex 已提交，正在启动：实现俄罗斯方块"
    assert service._tool_calls[(1, "call-1")].continuation == "abandoned"


@pytest.mark.asyncio
@pytest.mark.parametrize("response_id", ["tool-response", None])
async def test_late_tool_ready_after_barge_in_is_superseded_without_dispatch(
    response_id: str | None,
) -> None:
    """A cancelled provider turn cannot launch tool work that arrives late."""
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.local_speech_onset("speech-user")
    event = ToolCallReady(
        session_epoch=1,
        call_id="call-1",
        item_id="item-1",
        name="codex__run",
        arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
        response_id=response_id,
    )

    await service.handle_event(event)

    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    assert bridge.calls == []
    assert service.session.delegate_state("d-1") is None
    assert provider.injected == []

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="cancelled",
            reason="turn_detected",
        )
    )

    assert len(provider.injected) == 1
    assert provider.injected[0].kind == "tool_output"
    assert provider.injected[0].call_id == "call-1"
    assert provider.injected[0].content == '{"state":"superseded"}'
    assert provider.actions.count("create_response") == 0
    assert len(service._host_items) == 0
    state = service._tool_calls[(1, "call-1")]
    assert state.dispatch == "not_dispatched"
    assert state.final_disposition == "superseded"


@pytest.mark.asyncio
async def test_post_terminal_implicit_tool_ready_is_superseded_without_dispatch() -> None:
    """An uncorrelated call after cancellation cannot acquire new dispatch authority."""
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.local_speech_onset("speech-user")
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="cancelled",
            reason="turn_detected",
        )
    )

    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-late",
            item_id="item-late",
            name="codex__run",
            arguments={"work_order": "迟到任务", "origin_ref": "conversation:1"},
        )
    )

    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    assert bridge.calls == []
    assert service.session.delegate_state("d-1") is None
    assert len(provider.injected) == 1
    assert provider.injected[0].call_id == "call-late"
    assert provider.injected[0].content == '{"state":"superseded"}'
    assert provider.actions.count("create_response") == 0


@pytest.mark.asyncio
async def test_cancelled_output_failure_reconnect_never_replays_old_call_id() -> None:
    """Reconnect cannot inject a cancelled epoch's pending function-call output."""
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )
    await service.handle_event(
        UserSpeechStarted(session_epoch=1, speech_id="speech-user", provider_item_id="user-item")
    )
    await service.local_speech_onset("speech-local-uuid")
    provider.inject_failures = 1

    with pytest.raises(RealtimeDeliveryError, match="host item injection failed"):
        await service.handle_event(
            ResponseTerminal(
                session_epoch=1,
                response_id="tool-response",
                status="cancelled",
                reason="turn_detected",
            )
        )

    assert provider.injected == []
    assert service.session.delegate_state("d-1") == "running"

    await service.handle_event(
        ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
    )

    assert provider.epoch == 2
    assert [item.kind for item in provider.injected] == ["recovery", "progress"]
    assert all(item.call_id != "call-1" for item in provider.injected)
    state = service._tool_calls[(1, "call-1")]
    assert state.output == "pending"
    assert state.continuation == "abandoned"
    assert state.final_disposition == "abandoned"
    assert service.session.delegate_state("d-1") == "running"
    assert len(service._host_items) == 0


@pytest.mark.asyncio
async def test_late_tool_ready_does_not_replace_requested_continuation_batch() -> None:
    """Closing a stale call must not regress an already-requested batch to ready."""
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="completed",
            reason="completed",
        )
    )
    batch = service._continuation_batches[(1, "tool-response")]
    assert batch.phase == "requested"

    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-late",
            item_id="item-late",
            name="codex__run",
            arguments={"work_order": "迟到任务", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )

    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    assert [call.call_id for call in bridge.calls] == ["call-1"]
    assert [item.call_id for item in provider.injected] == ["call-1", "call-late"]
    assert provider.injected[-1].content == '{"state":"superseded"}'
    assert provider.actions.count("create_response") == 1
    assert batch.phase == "requested"
    late = service._tool_calls[(1, "call-late")]
    assert late.continuation == "abandoned"
    assert late.final_disposition == "superseded"

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="continuation"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="continuation",
            status="completed",
            reason="completed",
        )
    )

    assert service._tool_calls[(1, "call-1")].final_disposition == "completed"
    assert late.final_disposition == "superseded"


@pytest.mark.asyncio
async def test_host_continuation_cannot_enqueue_recursive_tool_batch() -> None:
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    bridge.acceptance = {
        "call-1": acceptance_for(
            "call-1",
            event_id="event-tool-1",
            delegate_id="d-1",
            summary="任务一",
        ),
        "call-2": acceptance_for(
            "call-2",
            event_id="event-tool-2",
            delegate_id="d-2",
            summary="任务二",
        ),
    }

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="origin-1"))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "任务一", "origin_ref": "conversation:1"},
            response_id="origin-1",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="origin-1",
            status="completed",
            reason="completed",
        )
    )
    assert provider.actions.count("create_response") == 1

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="continuation-1"))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-2",
            item_id="item-2",
            name="codex__run",
            arguments={"work_order": "任务二", "origin_ref": "conversation:1"},
            response_id="continuation-1",
        )
    )

    assert provider.actions.count("create_response") == 1

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="continuation-1",
            status="completed",
            reason="completed",
        )
    )

    assert provider.actions.count("create_response") == 1
    assert [intent.item.call_id for intent in provider.response_intents] == ["call-1"]
    assert [call.call_id for call in bridge.calls] == ["call-1"]
    assert (1, "call-2") not in service._tool_calls


@pytest.mark.asyncio
async def test_batch_injection_retry_resumes_without_duplicates_or_loss() -> None:
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    bridge.acceptance = {
        "call-1": acceptance_for(
            "call-1",
            event_id="event-tool-1",
            delegate_id="d-1",
            summary="任务一",
        ),
        "call-2": acceptance_for(
            "call-2",
            event_id="event-tool-2",
            delegate_id="d-2",
            summary="任务二",
        ),
    }
    provider.inject_failure_attempts = {2}
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    for index in (1, 2):
        await service.handle_event(
            ToolCallReady(
                session_epoch=1,
                call_id=f"call-{index}",
                item_id=f"item-{index}",
                name="codex__run",
                arguments={
                    "work_order": f"任务{index}",
                    "origin_ref": "conversation:1",
                },
                response_id="tool-response",
            )
        )

    with pytest.raises(RealtimeDeliveryError, match="host item injection failed"):
        await service.handle_event(
            ResponseTerminal(
                session_epoch=1,
                response_id="tool-response",
                status="completed",
                reason="completed",
            )
        )

    assert [item.call_id for item in provider.injected] == ["call-1"]
    assert provider.inject_attempts == 2

    await service.handle_event(UserSpeechStarted(session_epoch=1, speech_id="retry-wake"))

    assert [item.call_id for item in provider.injected] == ["call-1", "call-2"]
    assert provider.inject_attempts == 3
    assert provider.actions.count("create_response") == 0

    await service.handle_event(UserSpeechEnded(session_epoch=1, speech_id="retry-wake"))

    assert provider.actions.count("create_response") == 1
    assert [intent.item.call_id for intent in provider.response_intents] == ["call-1"]


@pytest.mark.asyncio
async def test_stale_epoch_tool_call_never_dispatches_or_injects() -> None:
    """Processing a rejected epoch can launch old user work in the current session."""
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(
        ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
    )
    before = list(provider.injected)

    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-stale",
            item_id="item-stale",
            name="codex__run",
            arguments={"work_order": "旧请求", "origin_ref": "conversation:1"},
        )
    )

    assert provider.injected == before
    assert service.session.delegate_state("d-1") is None
    assert service.codex_state == "idle"


@pytest.mark.asyncio
async def test_existing_spoken_ack_still_requests_mandatory_continuation() -> None:
    """Duplicate speech may be suppressed, but Qwen still gets its continuation
    pulse — after the audible generation finishes (#49)."""
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="tool-response",
            pcm=b"\x00\x01",
        )
    )

    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )

    generation = service.session.current_generation
    assert generation is not None
    assert provider.injected == []
    assert provider.response_intents == []

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="completed",
            reason="completed",
        )
    )

    assert len(provider.injected) == 1
    # #49: the ack waits for the audible generation instead of fencing it.
    assert provider.response_intents == []

    assert service.playback_done(generation.utterance_id, generation.generation_epoch)
    await service._drive_continuations()

    assert len(provider.response_intents) == 1
    assert provider.response_intents[0].kind == "delegation_acknowledgement"
    assert provider.actions[-1] == "create_response"


@pytest.mark.asyncio
async def test_permanently_rejected_continuation_is_abandoned_and_leaves_fifo() -> None:
    service, _provider, _runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )
    state = service._tool_calls[(1, "call-1")]
    service.session._responded_event_ids[state.acceptance.host_item.event_id] = None

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="completed",
            reason="completed",
        )
    )

    batch = service._continuation_batches[(1, "tool-response")]
    assert batch.phase == "abandoned"
    assert state.continuation == "abandoned"
    assert state.final_disposition == "abandoned"
    assert not service._continuation_fifo


@pytest.mark.asyncio
async def test_already_spoken_zero_frame_continuation_releases_queued_facts() -> None:
    """#49: the continuation waits out the audible renderer generation; once it
    completes silently the queued facts are released."""
    service, provider, runtime, frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="tool-response",
            pcm=b"\x00\x01",
        )
    )
    original_generation = service.session.current_generation
    assert original_generation is not None
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )
    assert runtime.observer is not None
    runtime.observer(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="working",
            internal_activity=1,
            elapsed=0.5,
        )
    )
    event = HandoffEvent(
        channel="codex",
        delegate_id="d-1",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={"result": "done"},
    )
    project_claimed_handoff(service, runtime, event, op="run")

    assert provider.injected == []
    assert provider.response_intents == []
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="completed",
            reason="completed",
        )
    )
    assert [item.kind for item in provider.injected] == ["tool_output"]
    # #49: the continuation waits for the audible generation to finish playing.
    assert [intent.kind for intent in provider.response_intents] == []
    assert service.session.current_generation == original_generation

    assert service.playback_done(
        original_generation.utterance_id,
        original_generation.generation_epoch,
    )
    await service._drive_continuations()
    assert [intent.kind for intent in provider.response_intents] == ["delegation_acknowledgement"]
    assert service.session.current_generation is None

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="silent-continuation"))
    assert service.session.active_provider_response_id == "silent-continuation"
    assert service.session.current_generation is None
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="silent-continuation",
            status="completed",
            reason="completed",
        )
    )
    assert service.session.active_provider_response_id is None

    await service.flush_host_items()
    assert [item.kind for item in provider.injected] == ["tool_output", "progress"]
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="silent-progress"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="silent-progress",
            status="completed",
            reason="completed",
        )
    )
    assert [item.kind for item in provider.injected] == ["tool_output", "progress", "final"]
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="silent-final"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="silent-final",
            status="completed",
            reason="completed",
        )
    )

    assert [intent.kind for intent in provider.response_intents] == [
        "delegation_acknowledgement",
        "host_fact",
        "host_fact",
    ]
    assert service.session.foreground_idle
    assert service.session.snapshot().spoken_event_ids == ()
    assert frames == [
        PlaybackFrame(
            utterance_id=original_generation.utterance_id,
            generation_epoch=original_generation.generation_epoch,
            sequence=0,
            pcm=b"\x00\x01",
        )
    ]


@pytest.mark.asyncio
async def test_continuation_waits_for_origin_then_suppresses_duplicate_provider_audio() -> None:
    """#49/#55 live: the origin is delivered in full before continuation, then
    host suppression enforces one acknowledgement even if Qwen emits PCM."""
    service, provider, _runtime, frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="tool-response", pcm=b"\x00\x01")
    )
    await service.handle_event(
        ResponseTranscriptFinal(
            session_epoch=1,
            response_id="tool-response",
            text="好，我帮你检查一下。",
        )
    )
    original_generation = service.session.current_generation
    assert original_generation is not None
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="completed",
            reason="completed",
        )
    )

    assert provider.response_intents == []
    assert service.session.current_generation == original_generation
    assert not any(action.startswith(("clear:", "cancel:")) for action in provider.actions)

    assert service.playback_done(
        original_generation.utterance_id,
        original_generation.generation_epoch,
        played_ms=640,
    )
    await service._drive_continuations()

    assert provider.response_intents[-1].kind == "delegation_acknowledgement"
    assert provider.response_intents[-1].origin_spoken is True
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="continuation"))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="continuation", pcm=b"\x02\x03")
    )

    assert service.session.current_generation is None
    assert not any(action.startswith(("clear:", "cancel:")) for action in provider.actions)
    assert [frame.pcm for frame in frames] == [b"\x00\x01"]

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="continuation",
            status="completed",
            reason="completed",
        )
    )
    assert service.session.foreground_idle
    assert service.session.snapshot().spoken_event_ids == ()


@pytest.mark.asyncio
async def test_same_turn_late_transcript_keeps_delivered_origin_continuation_silent() -> None:
    service, provider, _runtime, frames = make_service()
    await service.connect()
    await service.handle_event(UserSpeechStarted(1, "speech-1", provider_item_id="user-1"))
    await service.handle_event(UserSpeechEnded(1, "speech-1", provider_item_id="user-1"))
    await service.handle_event(ResponseStarted(1, "origin"))
    await service.handle_event(ResponseAudioDelta(1, "origin", b"\x00\x01"))
    generation = service.session.current_generation
    assert generation is not None
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="tool-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块"},
            response_id="origin",
        )
    )
    await service.handle_event(ResponseTerminal(1, "origin", "completed", "completed"))
    await service.handle_event(UserTranscriptFinal(1, "user-1", "实现俄罗斯方块"))
    assert service.playback_done(
        generation.utterance_id, generation.generation_epoch, played_ms=6682
    )
    await service._drive_continuations()

    acknowledgement = service._semantic_acknowledgements["background:d-1"]
    assert acknowledgement.origin_delivered is True
    assert provider.response_intents[-1].origin_spoken is True
    await service.handle_event(ResponseStarted(1, "continuation"))
    await service.handle_event(ResponseAudioDelta(1, "continuation", b"\x02\x03"))
    assert [frame.pcm for frame in frames] == [b"\x00\x01"]


@pytest.mark.asyncio
async def test_playback_before_late_transcript_retains_origin_delivery_proof() -> None:
    service, provider, _runtime, frames = make_service()
    await service.connect()
    await service.handle_event(UserSpeechStarted(1, "speech-1", provider_item_id="user-1"))
    await service.handle_event(UserSpeechEnded(1, "speech-1", provider_item_id="user-1"))
    await service.handle_event(ResponseStarted(1, "origin"))
    await service.handle_event(ResponseAudioDelta(1, "origin", b"\x00\x01"))
    generation = service.session.current_generation
    assert generation is not None
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="tool-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块"},
            response_id="origin",
        )
    )
    await service.handle_event(ResponseTerminal(1, "origin", "completed", "completed"))
    assert service.playback_done(
        generation.utterance_id, generation.generation_epoch, played_ms=6682
    )
    assert service._semantic_acknowledgements == {}
    await service.handle_event(UserTranscriptFinal(1, "user-1", "实现俄罗斯方块"))
    await service._drive_continuations()

    acknowledgement = service._semantic_acknowledgements["background:d-1"]
    assert acknowledgement.origin_delivered is True
    assert provider.response_intents[-1].origin_spoken is True
    await service.handle_event(ResponseStarted(1, "continuation"))
    await service.handle_event(ResponseAudioDelta(1, "continuation", b"\x02\x03"))
    assert [frame.pcm for frame in frames] == [b"\x00\x01"]


@pytest.mark.asyncio
async def test_unreferenced_spoken_response_does_not_occupy_origin_proof_ledger() -> None:
    service, _provider, _runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="conversation-only"))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="conversation-only", pcm=b"\x00\x01")
    )
    generation = service.session.current_generation
    assert generation is not None
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="conversation-only",
            status="completed",
            reason="completed",
        )
    )

    assert service.playback_done(
        generation.utterance_id,
        generation.generation_epoch,
        played_ms=640,
    )
    assert service._origin_delivery_proofs == {}


@pytest.mark.asyncio
async def test_interleaved_progress_does_not_reopen_delivered_delegation_ack() -> None:
    """A later progress utterance must not erase the delegate's audible origin ack."""
    service, provider, runtime, frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="tool-response", pcm=b"\x00\x01")
    )
    await service.handle_event(
        ResponseTranscriptFinal(
            session_epoch=1,
            response_id="tool-response",
            text="好的，我来实现俄罗斯方块。",
        )
    )
    origin_generation = service.session.current_generation
    assert origin_generation is not None
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )
    assert runtime.observer is not None
    runtime.observer(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="working",
            internal_activity=1,
            elapsed=0.5,
            summary="检查项目约束和文件结构",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="completed",
            reason="completed",
        )
    )

    assert service.playback_done(
        origin_generation.utterance_id,
        origin_generation.generation_epoch,
        played_ms=640,
    )
    await service.flush_host_items()
    assert provider.response_intents[-1].kind == "host_fact"

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="progress-response"))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="progress-response", pcm=b"\x02\x03")
    )
    await service.handle_event(
        ResponseTranscriptFinal(
            session_epoch=1,
            response_id="progress-response",
            text="Codex 正在检查项目约束和文件结构。",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="progress-response",
            status="completed",
            reason="completed",
        )
    )
    progress_generation = service.session.current_generation
    assert progress_generation is not None
    assert service.playback_done(
        progress_generation.utterance_id,
        progress_generation.generation_epoch,
        played_ms=860,
    )

    await service._drive_continuations()

    continuation = provider.response_intents[-1]
    assert continuation.kind == "delegation_acknowledgement"
    assert continuation.origin_spoken is True
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="continuation"))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="continuation", pcm=b"\x04\x05")
    )
    assert service.session.current_generation is None
    assert [frame.pcm for frame in frames] == [b"\x00\x01", b"\x02\x03"]


@pytest.mark.asyncio
async def test_interleaved_guard_speech_does_not_reopen_delivered_delegation_ack() -> None:
    service, provider, _runtime, frames = make_service()
    await service.connect()
    origin_generation = await prepare_origin_delegation(service)
    assert service.playback_done(
        origin_generation.utterance_id,
        origin_generation.generation_epoch,
        played_ms=640,
    )

    service._queue_host_item(host_fact("guard-hit"), priority=90, preemptive=True)
    await service.flush_host_items()
    assert provider.response_intents[-1].item.event_id == "guard-hit"
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="guard-response"))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="guard-response", pcm=b"\x02\x03")
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="guard-response",
            status="completed",
            reason="completed",
        )
    )
    guard_generation = service.session.current_generation
    assert guard_generation is not None
    assert service.playback_done(
        guard_generation.utterance_id,
        guard_generation.generation_epoch,
        played_ms=280,
    )

    await service._drive_continuations()

    continuation = provider.response_intents[-1]
    assert continuation.kind == "delegation_acknowledgement"
    assert continuation.origin_spoken is True
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="continuation"))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="continuation", pcm=b"\x04\x05")
    )
    assert [frame.pcm for frame in frames] == [b"\x00\x01", b"\x02\x03"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("played_ms", "renderer_started", "expected_origin_spoken"),
    [(0, False, False), (None, True, True)],
)
async def test_origin_delivery_proof_uses_played_time_or_legacy_started_ack(
    played_ms: int | None,
    renderer_started: bool,
    expected_origin_spoken: bool,
) -> None:
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    origin_generation = await prepare_origin_delegation(service)
    if renderer_started:
        assert service.playback_started(
            origin_generation.utterance_id,
            origin_generation.generation_epoch,
        )
    assert service.playback_done(
        origin_generation.utterance_id,
        origin_generation.generation_epoch,
        played_ms=played_ms,
    )

    await service._drive_continuations()

    assert provider.response_intents[-1].origin_spoken is expected_origin_spoken


@pytest.mark.asyncio
async def test_new_user_speech_before_continuation_revokes_origin_delivery_proof() -> None:
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    origin_generation = await prepare_origin_delegation(service)
    assert service.playback_done(
        origin_generation.utterance_id,
        origin_generation.generation_epoch,
        played_ms=640,
    )
    batch = service._continuation_batches[(1, "tool-response")]
    assert service._batch_origin_was_delivered(batch) is True

    await service.handle_event(UserSpeechStarted(1, "speech-2", provider_item_id="user-2"))
    assert service._batch_origin_was_delivered(batch) is False
    await service.handle_event(UserSpeechEnded(1, "speech-2", provider_item_id="user-2"))

    assert provider.response_intents[-1].kind == "delegation_acknowledgement"
    assert provider.response_intents[-1].origin_spoken is False


@pytest.mark.asyncio
async def test_origin_delivery_for_two_async_delegates_stays_audible() -> None:
    service, provider, _runtime, _frames = make_service()
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    bridge.acceptance = {
        "call-1": delegation_acceptance_for(
            "call-1",
            event_id="event-1",
            delegate_id="d-1",
            summary="实现俄罗斯方块",
        ),
        "call-2": delegation_acceptance_for(
            "call-2",
            event_id="event-2",
            delegate_id="d-2",
            summary="编写验收测试",
        ),
    }
    await service.connect()
    await service.handle_event(ResponseStarted(1, "origin-multi-async"))
    await service.handle_event(ResponseAudioDelta(1, "origin-multi-async", b"\x00\x01"))
    generation = service.session.current_generation
    assert generation is not None
    for call_id, item_id, work_order in (
        ("call-1", "tool-1", "实现俄罗斯方块"),
        ("call-2", "tool-2", "编写验收测试"),
    ):
        await service.handle_event(
            ToolCallReady(
                session_epoch=1,
                call_id=call_id,
                item_id=item_id,
                name="codex__run",
                arguments={"work_order": work_order, "origin_ref": "conversation:1"},
                response_id="origin-multi-async",
            )
        )
    await service.handle_event(ResponseTerminal(1, "origin-multi-async", "completed", "completed"))
    assert service.playback_done(
        generation.utterance_id,
        generation.generation_epoch,
        played_ms=640,
    )

    await service._drive_continuations()

    assert provider.response_intents[-1].kind == "delegation_acknowledgement"
    assert provider.response_intents[-1].origin_spoken is False


@pytest.mark.asyncio
async def test_origin_delivery_for_mixed_async_and_sync_tools_stays_audible() -> None:
    service, provider, runtime, _frames = make_service()
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    bridge.acceptance = {
        "call-async": delegation_acceptance_for(
            "call-async",
            event_id="event-async",
            delegate_id="d-1",
            summary="实现俄罗斯方块",
        ),
        "call-sync": sync_acceptance_for(
            "call-sync",
            event_id="event-sync",
            delegate_id="d-search",
        ),
    }
    await service.connect()
    await service.handle_event(ResponseStarted(1, "origin-mixed"))
    await service.handle_event(ResponseAudioDelta(1, "origin-mixed", b"\x00\x01"))
    generation = service.session.current_generation
    assert generation is not None
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-async",
            item_id="tool-async",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id="origin-mixed",
        )
    )
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-sync",
            item_id="tool-sync",
            name="search__search",
            arguments={"query": "北京天气", "origin_ref": "conversation:1"},
            response_id="origin-mixed",
        )
    )
    await service.handle_event(ResponseTerminal(1, "origin-mixed", "completed", "completed"))
    assert service.playback_done(
        generation.utterance_id,
        generation.generation_epoch,
        played_ms=640,
    )
    assert runtime.observer is not None
    runtime.observer(search_handoff("d-search"))
    await service.flush_host_items()
    await service._drive_continuations()

    assert provider.response_intents[-1].kind == "delegation_acknowledgement"
    assert provider.response_intents[-1].origin_spoken is False


@pytest.mark.asyncio
async def test_user_speech_before_tool_call_does_not_move_origin_revision_forward() -> None:
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="user-1", text="实现俄罗斯方块")
    )
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="tool-response", pcm=b"\x00\x01")
    )
    origin_generation = service.session.current_generation
    assert origin_generation is not None

    await service.handle_event(
        UserSpeechStarted(session_epoch=1, speech_id="speech-user", provider_item_id="user-2")
    )
    await service.handle_event(
        UserSpeechEnded(session_epoch=1, speech_id="speech-user", provider_item_id="user-2")
    )
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="completed",
            reason="completed",
        )
    )
    assert service.playback_done(
        origin_generation.utterance_id,
        origin_generation.generation_epoch,
        played_ms=640,
    )

    await service._drive_continuations()

    assert provider.response_intents[-1].origin_spoken is False


@pytest.mark.asyncio
async def test_reconnect_does_not_fallback_after_origin_ack_was_delivered() -> None:
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    origin_generation = await prepare_origin_delegation(service)
    assert service.playback_done(
        origin_generation.utterance_id,
        origin_generation.generation_epoch,
        played_ms=640,
    )

    await service.handle_event(
        ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
    )

    acknowledgement = service._semantic_acknowledgements["background:d-1"]
    assert acknowledgement.origin_delivered is True
    assert acknowledgement.phase == "delivered"
    assert all(
        item.event_id != "background:d-1"
        for item, epoch in zip(provider.injected, provider.injected_epochs, strict=True)
        if epoch == 2
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "late_transcript_order",
    ["transcript_before_playback", "playback_before_transcript"],
)
@pytest.mark.parametrize(
    ("played_ms", "expected_fallback_event_ids"),
    [(640, []), (0, ["background:d-1"])],
)
async def test_reconnect_late_transcript_single_origin_delivery_safety(
    late_transcript_order: str,
    played_ms: int,
    expected_fallback_event_ids: list[str],
) -> None:
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(UserSpeechStarted(1, "speech-1", provider_item_id="user-1"))
    await service.handle_event(UserSpeechEnded(1, "speech-1", provider_item_id="user-1"))
    await service.handle_event(ResponseStarted(1, "origin-late-single"))
    await service.handle_event(ResponseAudioDelta(1, "origin-late-single", b"\x00\x01"))
    generation = service.session.current_generation
    assert generation is not None
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="tool-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块"},
            response_id="origin-late-single",
        )
    )
    await service.handle_event(ResponseTerminal(1, "origin-late-single", "completed", "completed"))

    async def finish_transcript() -> None:
        await service.handle_event(UserTranscriptFinal(1, "user-1", "实现俄罗斯方块"))

    def finish_playback() -> None:
        assert service.playback_done(
            generation.utterance_id,
            generation.generation_epoch,
            played_ms=played_ms,
        )

    if late_transcript_order == "transcript_before_playback":
        await finish_transcript()
        finish_playback()
    else:
        finish_playback()
        await finish_transcript()

    await service.handle_event(
        ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
    )

    epoch_two_fallbacks = [
        item.event_id
        for item, epoch in zip(provider.injected, provider.injected_epochs, strict=True)
        if epoch == 2 and item.event_id.startswith("background:")
    ]
    assert epoch_two_fallbacks == expected_fallback_event_ids
    acknowledgement = service._semantic_acknowledgements["background:d-1"]
    assert acknowledgement.origin_delivered is (played_ms > 0)
    assert acknowledgement.phase == ("delivered" if played_ms > 0 else "requested")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "late_transcript_order",
    ["transcript_before_playback", "playback_before_transcript"],
)
async def test_reconnect_late_transcript_ambiguous_multi_tool_origin_keeps_fallbacks(
    late_transcript_order: str,
) -> None:
    service, provider, _runtime, _frames = make_service()
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    bridge.acceptance = {
        "call-1": delegation_acceptance_for(
            "call-1",
            event_id="event-1",
            delegate_id="d-1",
            summary="实现俄罗斯方块",
        ),
        "call-2": delegation_acceptance_for(
            "call-2",
            event_id="event-2",
            delegate_id="d-2",
            summary="编写验收测试",
        ),
    }
    await service.connect()
    await service.handle_event(UserSpeechStarted(1, "speech-1", provider_item_id="user-1"))
    await service.handle_event(UserSpeechEnded(1, "speech-1", provider_item_id="user-1"))
    await service.handle_event(ResponseStarted(1, "origin-late-multi"))
    await service.handle_event(ResponseAudioDelta(1, "origin-late-multi", b"\x00\x01"))
    generation = service.session.current_generation
    assert generation is not None
    for call_id, item_id, work_order in (
        ("call-1", "tool-1", "实现俄罗斯方块"),
        ("call-2", "tool-2", "编写验收测试"),
    ):
        await service.handle_event(
            ToolCallReady(
                session_epoch=1,
                call_id=call_id,
                item_id=item_id,
                name="codex__run",
                arguments={"work_order": work_order},
                response_id="origin-late-multi",
            )
        )
    await service.handle_event(ResponseTerminal(1, "origin-late-multi", "completed", "completed"))

    async def finish_transcript() -> None:
        await service.handle_event(UserTranscriptFinal(1, "user-1", "完成两个任务"))

    def finish_playback() -> None:
        assert service.playback_done(
            generation.utterance_id,
            generation.generation_epoch,
            played_ms=640,
        )

    if late_transcript_order == "transcript_before_playback":
        await finish_transcript()
        finish_playback()
    else:
        finish_playback()
        await finish_transcript()

    batch = service._continuation_batches[(1, "origin-late-multi")]
    assert service._batch_origin_was_delivered(batch) is False
    await service.handle_event(
        ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
    )

    acknowledgements = {
        event_id: acknowledgement.phase
        for event_id, acknowledgement in service._semantic_acknowledgements.items()
        if event_id in {"background:d-1", "background:d-2"}
    }
    assert acknowledgements == {
        "background:d-1": "requested",
        "background:d-2": "queued",
    }
    queued_or_injected = {
        item.event_id
        for item, epoch in zip(provider.injected, provider.injected_epochs, strict=True)
        if epoch == 2 and item.event_id.startswith("background:")
    } | {
        queued.intent.item.event_id
        for queued in service._host_items
        if queued.intent.item.event_id.startswith("background:")
    }
    assert queued_or_injected == {"background:d-1", "background:d-2"}


@pytest.mark.asyncio
async def test_barge_in_with_different_renderer_fences_only_active_provider_response() -> None:
    """The retained old renderer must not redirect cancellation or fence future turns."""
    service, provider, _runtime, frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="original"))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="original", pcm=b"\x00\x01")
    )
    original_generation = service.session.current_generation
    assert original_generation is not None
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="original",
            status="completed",
            reason="completed",
        )
    )
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="continuation"))

    await service.handle_event(
        UserSpeechStarted(session_epoch=1, speech_id="speech-user", provider_item_id="user-item")
    )
    await service.local_speech_onset("speech-local-uuid")

    assert provider.actions[-2:] == [
        "clear:utterance-progress:1",
        "cancel:continuation",
    ]
    assert not await service.session.accept(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="continuation",
            pcm=b"\x02\x03",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="continuation",
            status="cancelled",
            reason="turn_detected",
        )
    )
    await service.handle_event(
        UserSpeechEnded(
            session_epoch=1,
            speech_id="speech-user",
            provider_item_id="user-item",
        )
    )

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="fresh"))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="fresh", pcm=b"\x04\x05")
    )

    fresh_generation = service.session.current_generation
    assert fresh_generation is not None
    assert fresh_generation.response_id == "fresh"
    assert fresh_generation.generation_epoch != original_generation.generation_epoch
    assert frames[-1].pcm == b"\x04\x05"
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="fresh",
            status="completed",
            reason="completed",
        )
    )
    assert service.playback_done(
        fresh_generation.utterance_id,
        fresh_generation.generation_epoch,
    )


@pytest.mark.asyncio
async def test_no_audio_tool_response_yields_audible_renderer_acknowledged_continuation() -> None:
    """An audible continuation owns delivery truth only after its matching renderer done."""
    service, provider, _runtime, frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )
    assert provider.injected == []
    assert provider.response_intents == []
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="completed",
            reason="completed",
        )
    )
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="continuation"))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="continuation", pcm=b"\x00\x01")
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="continuation",
            status="completed",
            reason="completed",
        )
    )

    generation = service.session.current_generation
    assert generation is not None
    assert frames[-1].pcm == b"\x00\x01"
    assert service.session.snapshot().spoken_event_ids == ()
    assert service.session.foreground_idle is False
    assert not service.playback_done("foreign", generation.generation_epoch)
    assert service.playback_done(generation.utterance_id, generation.generation_epoch)
    assert service.session.snapshot().spoken_event_ids == ("event-tool",)
    assert service.session.foreground_idle


@pytest.mark.asyncio
async def test_later_user_turn_is_accepted_while_delegate_remains_running() -> None:
    """A live slow delegate must not block subsequent fast-brain user input."""
    service, _provider, runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )

    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="user-later", text="顺便解释一下进度")
    )

    assert runtime.posted == [UserInput(text="顺便解释一下进度")]
    assert service.session.delegate_state("d-1") == "running"


@pytest.mark.asyncio
async def test_accepted_call_keeps_progress_and_final_responses_deliverable() -> None:
    """Acceptance must not head-of-line block the running delegate's later host facts."""
    states: list[str] = []
    service, provider, runtime, _frames = make_service(on_codex_state=states.append)
    await service.connect()
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )
    assert provider.response_intents[-1].kind == "delegation_acknowledgement"
    await complete_audible_response(service, "ack-response")

    assert runtime.observer is not None
    runtime.observer(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="working",
            internal_activity=1,
            elapsed=0.5,
        )
    )
    await service.flush_host_items()
    assert provider.injected[-1].kind == "progress"
    assert provider.response_intents[-1].kind == "host_fact"
    await complete_audible_response(service, "progress-response")

    event = HandoffEvent(
        channel="codex",
        delegate_id="d-1",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={"result": "done"},
    )
    project_claimed_handoff(service, runtime, event, op="run")
    await service.flush_host_items()

    assert provider.injected[-1].kind == "final"
    assert provider.response_intents[-1].kind == "host_fact"
    assert service.session.delegate_state("d-1") == "completed"
    assert states == ["running", "idle"]


@pytest.mark.asyncio
async def test_zero_frame_acknowledgements_release_progress_and_final_delivery() -> None:
    """Silent host responses must not leave later delegate facts behind a phantom renderer."""
    service, provider, runtime, frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )
    assert runtime.observer is not None
    runtime.observer(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="working",
            internal_activity=1,
            elapsed=0.5,
        )
    )
    event = HandoffEvent(
        channel="codex",
        delegate_id="d-1",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={"result": "done"},
    )
    project_claimed_handoff(service, runtime, event, op="run")

    assert provider.injected == []
    assert provider.response_intents == []

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="completed",
            reason="completed",
        )
    )

    assert [item.kind for item in provider.injected] == ["tool_output"]
    assert [intent.kind for intent in provider.response_intents] == ["delegation_acknowledgement"]
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="silent-ack"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="silent-ack",
            status="completed",
            reason="completed",
        )
    )

    assert [intent.kind for intent in provider.response_intents] == [
        "delegation_acknowledgement",
        "host_fact",
    ]
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="silent-progress"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="silent-progress",
            status="completed",
            reason="completed",
        )
    )

    assert [item.kind for item in provider.injected] == ["tool_output", "progress", "final"]
    assert [intent.kind for intent in provider.response_intents] == [
        "delegation_acknowledgement",
        "host_fact",
        "host_fact",
    ]
    assert service.session.current_generation is None
    assert frames == []


@pytest.mark.asyncio
async def test_silent_continuation_releases_later_user_audio_while_delegate_runs() -> None:
    """Completing a zero-frame continuation must restore the fast conversational turn."""
    service, provider, runtime, frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="completed",
            reason="completed",
        )
    )
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="silent-continuation"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="silent-continuation",
            status="completed",
            reason="completed",
        )
    )

    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="user-later", text="现在能听到吗")
    )
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="user-response"))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="user-response", pcm=b"\x00\x01")
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="user-response",
            status="completed",
            reason="completed",
        )
    )

    generation = service.session.current_generation
    assert generation is not None
    assert frames[-1].pcm == b"\x00\x01"
    assert service.playback_done(generation.utterance_id, generation.generation_epoch)
    assert runtime.posted == [UserInput(text="现在能听到吗")]
    assert service.session.delegate_state("d-1") == "running"
    assert provider.response_intents[0].kind == "delegation_acknowledgement"

    assert runtime.observer is not None
    event = HandoffEvent(
        channel="codex",
        delegate_id="d-1",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={"result": "done"},
    )
    project_claimed_handoff(service, runtime, event, op="run")
    await service.flush_host_items()
    assert provider.injected[-1].kind == "final"
    assert provider.response_intents[-1].kind == "host_fact"
    await complete_audible_response(service, "final-response")
    assert service.session.delegate_state("d-1") == "completed"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reconnect_phase",
    [
        "dispatched_before_origin_terminal",
        "output_confirmed_before_continuation_request",
        "continuation_requested_before_response_started",
        "continuation_bound_before_terminal",
    ],
)
async def test_reconnect_reconciles_unheard_delegate_acknowledgement(
    reconnect_phase: str,
) -> None:
    """Every old provider phase must close without losing already-dispatched work."""
    service, provider, runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )

    if reconnect_phase == "output_confirmed_before_continuation_request":
        provider.response_failures = 1
        with pytest.raises(RealtimeDeliveryError, match="response request failed"):
            await service.handle_event(
                ResponseTerminal(
                    session_epoch=1,
                    response_id="tool-response",
                    status="completed",
                    reason="completed",
                )
            )
    elif reconnect_phase != "dispatched_before_origin_terminal":
        await service.handle_event(
            ResponseTerminal(
                session_epoch=1,
                response_id="tool-response",
                status="completed",
                reason="completed",
            )
        )
        if reconnect_phase == "continuation_bound_before_terminal":
            await service.handle_event(
                ResponseStarted(session_epoch=1, response_id="continuation-1")
            )

    await service.handle_event(
        ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
    )

    assert service.session.delegate_state("d-1") == "running"
    assert all(
        item.call_id != "call-1"
        for item, epoch in zip(provider.injected, provider.injected_epochs, strict=True)
        if epoch == 2
    )
    assert all(
        batch.phase not in {"requested", "bound"}
        for (epoch, _response_id), batch in service._continuation_batches.items()
        if epoch == 1
    )
    background_items = [
        item
        for item, epoch in zip(provider.injected, provider.injected_epochs, strict=True)
        if epoch == 2
        and item.kind == "progress"
        and item.content == "Codex 已提交，正在启动：实现俄罗斯方块"
    ]
    assert len(background_items) == 1
    assert background_items[0].event_id == "background:d-1"
    epoch_two_intents = [
        intent
        for intent, epoch in zip(
            provider.response_intents,
            provider.response_epochs,
            strict=True,
        )
        if epoch == 2
    ]
    assert [intent.item.event_id for intent in epoch_two_intents] == ["background:d-1"]

    await service.handle_event(ResponseStarted(session_epoch=2, response_id="recovery-ack"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=2,
            response_id="recovery-ack",
            status="completed",
            reason="completed",
        )
    )
    assert service.session.foreground_idle

    service.project_runtime_event(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="working",
            internal_activity=2,
            elapsed=1.0,
        )
    )
    await service.flush_host_items()
    await service.handle_event(ResponseStarted(session_epoch=2, response_id="progress-2"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=2,
            response_id="progress-2",
            status="completed",
            reason="completed",
        )
    )
    event = HandoffEvent(
        channel="codex",
        delegate_id="d-1",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={"result": "done"},
    )
    project_claimed_handoff(service, runtime, event, op="run")
    await service.flush_host_items()
    await service.handle_event(ResponseStarted(session_epoch=2, response_id="final-2"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=2,
            response_id="final-2",
            status="completed",
            reason="completed",
        )
    )

    assert service.session.delegate_state("d-1") == "completed"
    assert service.session.foreground_idle


@pytest.mark.asyncio
@pytest.mark.parametrize("origin_status", ["cancelled", "failed"])
async def test_reconnect_retries_unbound_fallback_acknowledgement(
    origin_status: str,
) -> None:
    """A requested fallback fact is still unheard until its response is bound."""
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status=origin_status,
            reason="provider_turn_lost",
        )
    )

    state = service._tool_calls[(1, "call-1")]
    assert state.final_disposition == "abandoned"
    assert len(service._host_items) == 0
    assert [intent.item.event_id for intent in provider.response_intents] == ["background:d-1"]

    await service.handle_event(
        ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
    )

    assert service.session.delegate_state("d-1") == "running"
    epoch_two_items = [
        item
        for item, epoch in zip(provider.injected, provider.injected_epochs, strict=True)
        if epoch == 2
    ]
    assert [item.event_id for item in epoch_two_items if item.kind == "progress"] == [
        "background:d-1"
    ]
    assert all(item.kind != "tool_output" and item.call_id != "call-1" for item in epoch_two_items)
    assert [
        intent.item.event_id
        for intent, epoch in zip(
            provider.response_intents,
            provider.response_epochs,
            strict=True,
        )
        if epoch == 2
    ] == ["background:d-1"]

    await service.handle_event(ResponseStarted(session_epoch=2, response_id="background-ack-2"))
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=2,
            response_id="background-ack-2",
            pcm=b"\x00\x01",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=2,
            response_id="background-ack-2",
            status="completed",
            reason="completed",
        )
    )
    generation = service.session.current_generation
    assert generation is not None
    assert service.playback_done(generation.utterance_id, generation.generation_epoch)

    await service.handle_event(
        ProviderErrorEvent(session_epoch=2, code="disconnected", recoverable=True)
    )

    assert provider.epoch == 3
    assert all(
        item.event_id != "background:d-1"
        for item, epoch in zip(provider.injected, provider.injected_epochs, strict=True)
        if epoch == 3
    )
    assert all(
        intent.item.event_id != "background:d-1"
        for intent, epoch in zip(
            provider.response_intents,
            provider.response_epochs,
            strict=True,
        )
        if epoch == 3
    )


@pytest.mark.asyncio
async def test_reconnect_does_not_repeat_completed_tool_acknowledgement() -> None:
    """A completed continuation has already conveyed acceptance to the provider."""
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="completed",
            reason="completed",
        )
    )
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-ack"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-ack",
            status="completed",
            reason="completed",
        )
    )

    await service.handle_event(
        ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
    )

    assert service.session.delegate_state("d-1") == "running"
    assert all(
        item.event_id != "background:d-1"
        for item, epoch in zip(provider.injected, provider.injected_epochs, strict=True)
        if epoch == 2
    )
    assert all(
        intent.item.event_id != "background:d-1"
        for intent, epoch in zip(
            provider.response_intents,
            provider.response_epochs,
            strict=True,
        )
        if epoch == 2
    )


@pytest.mark.asyncio
async def test_cancelled_bound_fallback_acknowledgement_requeues_for_retry() -> None:
    """A cancelled fallback response has not delivered the acknowledgement."""
    service, _provider, _runtime, _frames = make_service()
    await service.connect()
    await request_fallback_acknowledgement(service, session_epoch=1)
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="fallback-ack"))

    event_id = "background:d-1"
    acknowledgement = service._semantic_acknowledgements[event_id]
    assert (acknowledgement.phase, acknowledgement.response_id, acknowledgement.binding) == (
        "bound",
        "fallback-ack",
        "fallback",
    )

    service._finish_semantic_acknowledgement(
        ResponseTerminal(
            session_epoch=1,
            response_id="fallback-ack",
            status="cancelled",
            reason="client_cancelled",
        )
    )

    acknowledgement = service._semantic_acknowledgements[event_id]
    assert (acknowledgement.phase, acknowledgement.response_id, acknowledgement.binding) == (
        "queued",
        None,
        None,
    )
    assert any(item.semantic_event_id == event_id for item in service._host_items)


@pytest.mark.asyncio
async def test_failed_bound_fallback_acknowledgement_retries_once_then_stays_pending() -> None:
    """A repeat failure must stop retrying until later provider health evidence."""
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    await request_fallback_acknowledgement(service, session_epoch=1)
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="fallback-first"))

    event_id = "background:d-1"
    first_terminal = ResponseTerminal(
        session_epoch=1,
        response_id="fallback-first",
        status="failed",
        reason="provider_failed",
    )
    assert await service.session.accept(first_terminal)
    service._finish_semantic_acknowledgement(first_terminal)
    acknowledgement = service._semantic_acknowledgements[event_id]
    assert (acknowledgement.phase, acknowledgement.response_id, acknowledgement.binding) == (
        "queued",
        None,
        None,
    )
    assert any(item.semantic_event_id == event_id for item in service._host_items)

    await service.flush_host_items()
    acknowledgement.phase = "requested"
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="fallback-retry"))
    response_creates = len(provider.response_intents)
    retry_terminal = ResponseTerminal(
        session_epoch=1,
        response_id="fallback-retry",
        status="failed",
        reason="provider_failed",
    )
    assert await service.session.accept(retry_terminal)
    service._finish_semantic_acknowledgement(retry_terminal)

    acknowledgement = service._semantic_acknowledgements[event_id]
    assert (acknowledgement.phase, acknowledgement.response_id, acknowledgement.binding) == (
        "pending",
        None,
        None,
    )
    assert not any(item.semantic_event_id == event_id for item in service._host_items)
    assert len(provider.response_intents) == response_creates


@pytest.mark.asyncio
async def test_reconnect_reopens_exhausted_failed_fallback_acknowledgement() -> None:
    """A reconnect grants one delivery attempt, not a fresh immediate-retry budget."""
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    event_id = "background:d-1"
    acknowledgement = _SemanticAcknowledgement(
        event_id=event_id,
        summary="实现俄罗斯方块",
        failed_retry_consumed=True,
    )
    service._semantic_acknowledgements[event_id] = acknowledgement

    await service._reconnect_provider_session()

    assert [
        intent.item.event_id
        for intent, epoch in zip(provider.response_intents, provider.response_epochs, strict=True)
        if epoch == 2
    ] == [event_id]
    await service.handle_event(ResponseStarted(session_epoch=2, response_id="fallback-recovered"))
    recovered_terminal = ResponseTerminal(
        session_epoch=2,
        response_id="fallback-recovered",
        status="failed",
        reason="provider_failed",
    )
    assert await service.session.accept(recovered_terminal)
    service._finish_semantic_acknowledgement(recovered_terminal)
    assert acknowledgement.phase == "pending"
    assert acknowledgement.failed_retry_consumed is True
    assert not any(item.semantic_event_id == event_id for item in service._host_items)


@pytest.mark.asyncio
async def test_completed_terminal_reopens_exhausted_failed_fallback_acknowledgement() -> None:
    """Each completed health event grants exactly one deferred delivery attempt."""
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    event_id = "background:d-1"
    acknowledgement = _SemanticAcknowledgement(
        event_id=event_id,
        summary="实现俄罗斯方块",
        failed_retry_consumed=True,
    )
    service._semantic_acknowledgements[event_id] = acknowledgement
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="health-response"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="health-response",
            status="completed",
            reason="completed",
        )
    )

    assert provider.response_intents[-1].item.event_id == event_id
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="fallback-recovered"))
    recovered_terminal = ResponseTerminal(
        session_epoch=1,
        response_id="fallback-recovered",
        status="failed",
        reason="provider_failed",
    )
    assert await service.session.accept(recovered_terminal)
    service._finish_semantic_acknowledgement(recovered_terminal)
    assert acknowledgement.phase == "pending"
    assert acknowledgement.failed_retry_consumed is True
    assert not any(item.semantic_event_id == event_id for item in service._host_items)

    service._reopen_failed_semantic_acknowledgements()

    assert acknowledgement.phase == "queued"
    assert [item.semantic_event_id for item in service._host_items] == [event_id]
    assert acknowledgement.failed_retry_consumed is True


@pytest.mark.asyncio
async def test_consecutive_unbound_reconnects_retry_stable_fallback_acknowledgement() -> None:
    """Fallback retry ownership must survive beyond the original call's provider epoch."""
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    await request_fallback_acknowledgement(service, session_epoch=1)

    await service.handle_event(
        ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
    )
    await service.handle_event(
        ProviderErrorEvent(session_epoch=2, code="disconnected", recoverable=True)
    )

    assert provider.epoch == 3
    for epoch in (1, 2, 3):
        assert [
            intent.item.event_id
            for intent, response_epoch in zip(
                provider.response_intents,
                provider.response_epochs,
                strict=True,
            )
            if response_epoch == epoch and intent.item.event_id == "background:d-1"
        ] == ["background:d-1"]
    assert service.session.delegate_state("d-1") == "running"
    assert all(
        item.kind != "tool_output" and item.call_id != "call-1"
        for item, epoch in zip(provider.injected, provider.injected_epochs, strict=True)
        if epoch in {2, 3}
    )


@pytest.mark.asyncio
async def test_completed_fallback_ack_survives_session_dedupe_churn() -> None:
    """Durable fallback completion cannot depend on the session's bounded replay window."""
    serial = count(1)
    service, provider, _runtime, _frames = make_service(
        id_factory=lambda: f"host-fallback-{next(serial)}"
    )
    await service.connect()
    await service.handle_event(
        ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
    )
    await service.handle_event(
        ProviderErrorEvent(session_epoch=2, code="disconnected", recoverable=True)
    )
    await request_fallback_acknowledgement(service, session_epoch=3)
    await service.handle_event(ResponseStarted(session_epoch=3, response_id="background-ack-3"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=3,
            response_id="background-ack-3",
            status="completed",
            reason="completed",
        )
    )

    for index in range(501):
        item = HostContextItem.progress(
            host_item_id=f"host-churn-{index}",
            event_id=f"churn:{index}",
            content=f"churn {index}",
        )
        assert await service.session.deliver_host_item(item)
        response_id = f"churn-response-{index}"
        assert await service.session.accept(
            ResponseStarted(session_epoch=3, response_id=response_id)
        )
        assert await service.session.accept(
            ResponseTerminal(
                session_epoch=3,
                response_id=response_id,
                status="completed",
                reason="completed",
            )
        )
    assert not service.session.host_event_is_deduplicated("background:d-1")

    await service.handle_event(
        ProviderErrorEvent(session_epoch=3, code="disconnected", recoverable=True)
    )

    assert provider.epoch == 4
    assert all(
        item.event_id != "background:d-1"
        for item, epoch in zip(provider.injected, provider.injected_epochs, strict=True)
        if epoch == 4
    )
    assert all(
        intent.item.event_id != "background:d-1"
        for intent, epoch in zip(
            provider.response_intents,
            provider.response_epochs,
            strict=True,
        )
        if epoch == 4
    )


@pytest.mark.asyncio
async def test_semantic_ack_capacity_refuses_before_delegate_dispatch() -> None:
    """A full semantic ledger must apply backpressure before delegated work starts."""
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    for index in range(499):
        event_id = f"background:survivor-{index}"
        service._semantic_acknowledgements[event_id] = _SemanticAcknowledgement(
            event_id=event_id,
            summary=f"surviving task {index}",
        )
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))

    bridge.acceptance = acceptance_for(
        "call-499",
        event_id="event-499",
        delegate_id="delegate-499",
        summary="任务 499",
    )
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-499",
            item_id="item-499",
            name="codex__run",
            arguments={"work_order": "任务 499", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )
    bridge.acceptance = acceptance_for(
        "call-500",
        event_id="event-500",
        delegate_id="delegate-500",
        summary="任务 500",
    )
    refused = ToolCallReady(
        session_epoch=1,
        call_id="call-500",
        item_id="item-500",
        name="codex__run",
        arguments={"work_order": "任务 500", "origin_ref": "conversation:1"},
        response_id="tool-response",
    )
    await service.handle_event(refused)

    assert [call.call_id for call in bridge.calls] == ["call-499"]
    assert service.session.delegate_state("delegate-499") == "running"
    assert service.session.delegate_state("delegate-500") is None
    assert "background:delegate-499" in service._semantic_acknowledgements
    assert "background:delegate-500" not in service._semantic_acknowledgements
    overflow = service._overflow_tool_calls[(1, "call-500")]
    assert overflow.acceptance.code == "over_capacity"
    assert overflow.acceptance.host_item.content == '{"code":"over_capacity","state":"refused"}'

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="completed",
            reason="completed",
        )
    )
    refusals = [
        item
        for item in provider.injected
        if item.content == '{"code":"over_capacity","state":"refused"}'
    ]
    assert len(refusals) == 1
    before = (len(bridge.calls), len(provider.injected), len(provider.response_intents))

    await service.handle_event(refused)

    assert (len(bridge.calls), len(provider.injected), len(provider.response_intents)) == before


@pytest.mark.asyncio
async def test_output_confirmation_failure_replay_resumes_without_redispatch() -> None:
    """A failed confirmation must retry output, not launch a second slow delegate."""
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    provider.inject_failures = 1
    event = ToolCallReady(
        session_epoch=1,
        call_id="call-1",
        item_id="item-1",
        name="codex__run",
        arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
        response_id="tool-response",
    )

    await service.handle_event(event)
    assert provider.injected == []
    with pytest.raises(RuntimeError, match="inject failed"):
        await service.handle_event(
            ResponseTerminal(
                session_epoch=1,
                response_id="tool-response",
                status="completed",
                reason="completed",
            )
        )
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    replayed_output = HostContextItem.tool_output(
        host_item_id="replayed-host",
        event_id="replayed-event",
        call_id="call-1",
        content='{"state":"accepted"}',
    )
    bridge.acceptance = ToolAcceptance(
        accepted=True,
        code="accepted",
        host_item=replayed_output,
        response_intent=HostResponseIntent.delegation_acknowledgement(
            item=replayed_output,
            task_summary="不应派发",
        ),
        delegate_id="d-replayed",
        executor="codex",
    )

    await service.handle_event(event)

    assert provider.injected[0].host_item_id == "host-tool"
    assert service.session.delegate_state("d-1") == "running"
    assert service.session.delegate_state("d-replayed") is None


@pytest.mark.asyncio
async def test_response_request_failure_replay_resumes_without_duplicate_output() -> None:
    """A failed create_response must leave the confirmed acknowledgement queued."""
    service, provider, _runtime, _frames = make_service()
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    provider.response_failures = 1
    event = ToolCallReady(
        session_epoch=1,
        call_id="call-1",
        item_id="item-1",
        name="codex__run",
        arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
        response_id="tool-response",
    )

    await service.handle_event(event)
    assert provider.injected == []
    with pytest.raises(RuntimeError, match="response failed"):
        await service.handle_event(
            ResponseTerminal(
                session_epoch=1,
                response_id="tool-response",
                status="completed",
                reason="completed",
            )
        )
    await service.handle_event(event)

    assert len(provider.injected) == 1
    assert provider.actions.count("create_response") == 2
    assert len(provider.response_intents) == 1
    assert provider.response_intents[0].task_summary == "实现俄罗斯方块"


@pytest.mark.asyncio
async def test_terminal_tool_state_is_pruned_before_capacity_refusal() -> None:
    """A completed replay tombstone must yield capacity before active work is refused."""
    serial = count(1)
    service, _provider, _runtime, _frames = make_service(
        id_factory=lambda: f"host-capacity-{next(serial)}"
    )
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="completed-origin"))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "已完成任务", "origin_ref": "conversation:1"},
            response_id="completed-origin",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="completed-origin",
            status="completed",
            reason="completed",
        )
    )
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="completed-ack"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="completed-ack",
            status="completed",
            reason="completed",
        )
    )
    assert service._tool_calls[(1, "call-1")].final_disposition == "completed"

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="active-origin"))
    for index in range(499):
        await service.handle_event(
            ToolCallReady(
                session_epoch=1,
                call_id=f"active-{index}",
                item_id=f"active-item-{index}",
                name="codex__run",
                arguments={"work_order": f"活动任务 {index}", "origin_ref": "conversation:1"},
                response_id="active-origin",
            )
        )
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="active-extra",
            item_id="active-item-extra",
            name="codex__run",
            arguments={"work_order": "活动任务 extra", "origin_ref": "conversation:1"},
            response_id="active-origin",
        )
    )

    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    assert len(bridge.calls) == 501
    assert (1, "call-1") not in service._tool_calls
    assert (1, "active-extra") in service._tool_calls
    assert len(service._tool_calls) == 500


@pytest.mark.asyncio
async def test_active_tool_capacity_refuses_without_evicting_or_redispatching() -> None:
    """Capacity pressure must close the extra call while preserving every active delegate."""
    serial = count(1)
    service, provider, _runtime, _frames = make_service(
        id_factory=lambda: f"host-capacity-{next(serial)}"
    )
    await service.connect()
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    active_keys: list[tuple[int, str]] = []
    for index in range(500):
        call_id = f"call-{index}"
        bridge.acceptance = acceptance_for(
            call_id,
            event_id=f"event-{index}",
            delegate_id=f"delegate-{index}",
            summary=f"任务 {index}",
        )
        await service.handle_event(
            ToolCallReady(
                session_epoch=1,
                call_id=call_id,
                item_id=f"item-{index}",
                name="codex__run",
                arguments={"work_order": f"任务 {index}", "origin_ref": "conversation:1"},
                response_id="tool-response",
            )
        )
        active_keys.append((1, call_id))
    overflow = ToolCallReady(
        session_epoch=1,
        call_id="call-overflow",
        item_id="item-overflow",
        name="codex__run",
        arguments={"work_order": "溢出任务", "origin_ref": "conversation:1"},
        response_id="tool-response",
    )

    await service.handle_event(overflow)

    assert len(bridge.calls) == 500
    assert all(key in service._tool_calls for key in active_keys)
    assert all(service._tool_calls[key].acceptance.accepted for key in active_keys)
    assert len(service._tool_calls) == 500
    overflow_state = service._overflow_tool_calls[(1, "call-overflow")]
    assert overflow_state.acceptance.code == "over_capacity"
    assert overflow_state.acceptance.host_item.content == (
        '{"code":"over_capacity","state":"refused"}'
    )
    assert provider.injected == []

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="completed",
            reason="completed",
        )
    )

    refusals = [
        item
        for item in provider.injected
        if item.content == '{"code":"over_capacity","state":"refused"}'
    ]
    assert len(refusals) == 1
    assert provider.response_intents[-1].kind == "delegation_acknowledgement"
    before = (len(bridge.calls), len(provider.injected), len(provider.response_intents))

    await service.handle_event(overflow)

    assert (len(bridge.calls), len(provider.injected), len(provider.response_intents)) == before


@pytest.mark.asyncio
async def test_terminal_semantic_capacity_refusals_are_pruned_before_reconnect() -> None:
    """Terminal refusal slots must be reusable without resetting the provider epoch."""
    serial = count(1)
    service, provider, _runtime, _frames = make_service(
        id_factory=lambda: f"host-semantic-overflow-{next(serial)}"
    )
    await service.connect()
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    for index in range(500):
        event_id = f"background:survivor-{index}"
        service._semantic_acknowledgements[event_id] = _SemanticAcknowledgement(
            event_id=event_id,
            summary=f"surviving task {index}",
        )

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="first-origin"))
    for index in range(32):
        await service.handle_event(
            ToolCallReady(
                session_epoch=1,
                call_id=f"terminal-refusal-{index}",
                item_id=f"terminal-refusal-item-{index}",
                name="codex__run",
                arguments={"work_order": f"拒绝任务 {index}", "origin_ref": "conversation:1"},
                response_id="first-origin",
            )
        )
    terminal_states = tuple(service._overflow_tool_calls.values())
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="first-origin",
            status="completed",
            reason="completed",
        )
    )
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="first-refusal"))
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="first-refusal",
            status="completed",
            reason="completed",
        )
    )
    assert len(terminal_states) == 32
    assert all(state.final_disposition == "refused" for state in terminal_states)

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="next-origin"))
    next_refusal = ToolCallReady(
        session_epoch=1,
        call_id="next-refusal",
        item_id="next-refusal-item",
        name="codex__run",
        arguments={"work_order": "下一项拒绝任务", "origin_ref": "conversation:1"},
        response_id="next-origin",
    )
    await service.handle_event(next_refusal)

    assert provider.epoch == 1
    assert service.session.session_epoch == 1
    assert bridge.calls == []
    assert tuple(service._overflow_tool_calls) == ((1, "next-refusal"),)
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="next-origin",
            status="completed",
            reason="completed",
        )
    )
    new_refusals = [
        item
        for item in provider.injected
        if item.call_id == "next-refusal"
        and item.content == '{"code":"over_capacity","state":"refused"}'
    ]
    assert len(new_refusals) == 1
    before_replay = (len(provider.injected), len(provider.response_intents))

    await service.handle_event(next_refusal)

    assert provider.epoch == 1
    assert service.session.session_epoch == 1
    assert bridge.calls == []
    assert (len(provider.injected), len(provider.response_intents)) == before_replay


@pytest.mark.asyncio
async def test_full_overflow_refusal_ledger_reconnects_without_dispatch_or_eviction() -> None:
    """A full refusal ledger must reset the provider epoch rather than sacrifice active work."""
    serial = count(1)
    service, provider, _runtime, _frames = make_service(
        id_factory=lambda: f"host-overflow-{next(serial)}"
    )
    await service.connect()
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="tool-response"))
    active_keys: list[tuple[int, str]] = []
    for index in range(500):
        call_id = f"call-{index}"
        bridge.acceptance = acceptance_for(
            call_id,
            event_id=f"event-{index}",
            delegate_id=f"delegate-{index}",
            summary=f"任务 {index}",
        )
        await service.handle_event(
            ToolCallReady(
                session_epoch=1,
                call_id=call_id,
                item_id=f"item-{index}",
                name="codex__run",
                arguments={"work_order": f"任务 {index}", "origin_ref": "conversation:1"},
                response_id="tool-response",
            )
        )
        active_keys.append((1, call_id))
    for index in range(32):
        await service.handle_event(
            ToolCallReady(
                session_epoch=1,
                call_id=f"overflow-{index}",
                item_id=f"overflow-item-{index}",
                name="codex__run",
                arguments={"work_order": f"溢出任务 {index}", "origin_ref": "conversation:1"},
                response_id="tool-response",
            )
        )
    overflow_states = tuple(service._overflow_tool_calls.values())

    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="overflow-reset",
            item_id="overflow-item-reset",
            name="codex__run",
            arguments={"work_order": "触发重连", "origin_ref": "conversation:1"},
            response_id="tool-response",
        )
    )

    assert provider.epoch == 2
    assert len(bridge.calls) == 500
    assert all(key in service._tool_calls for key in active_keys)
    assert all(state.continuation == "abandoned" for state in overflow_states)
    assert all(state.final_disposition == "refused" for state in overflow_states)
    assert len(service._overflow_tool_calls) == 32
    assert all(
        item.kind != "tool_output"
        for item, epoch in zip(provider.injected, provider.injected_epochs, strict=True)
        if epoch == 2
    )


@pytest.mark.asyncio
async def test_progress_barge_in_final_and_reconnect_preserve_delegate_authority() -> None:
    service, provider, runtime, frames = make_service()
    await service.connect()
    service.session.register_delegate("d-1", summary="实现俄罗斯方块", state="running")

    assert runtime.observer is not None
    runtime.observer(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="working",
            internal_activity=3,
            elapsed=1.25,
        )
    )
    await service.flush_host_items()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="progress-response"))
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="progress-response",
            pcm=b"\x00\x01",
        )
    )

    await service.handle_event(
        UserSpeechStarted(session_epoch=1, speech_id="speech-1", provider_item_id="user-item")
    )
    await service.local_speech_onset("speech-local-uuid")

    assert frames
    assert provider.actions[-2:] == [
        "clear:utterance-progress:1",
        "cancel:progress-response",
    ]
    assert service.session.delegate_state("d-1") == "running"
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="progress-response",
            status="cancelled",
            reason="cancelled",
        )
    )
    # The renderer acknowledges every playback.clear; the fence report reopens
    # the foreground for host delivery.
    service.playback_cleared("utterance-progress", 1, 0)

    await service.handle_event(
        UserSpeechEnded(session_epoch=1, speech_id="speech-1", provider_item_id="user-item")
    )

    event = HandoffEvent(
        channel="codex",
        delegate_id="d-1",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={"result": {"final_message": {"text": "完成"}}},
    )
    project_claimed_handoff(service, runtime, event, op="run")
    await service.flush_host_items()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="final-response"))
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="final-response",
            pcm=b"\x00\x01",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="final-response",
            status="completed",
            reason="completed",
        )
    )
    generation = service.session.current_generation
    assert generation is not None
    assert service.playback_done(generation.utterance_id, generation.generation_epoch)
    assert not service.playback_done(generation.utterance_id, generation.generation_epoch)
    assert service.session.delegate_state("d-1") == "completed"

    await service.handle_event(
        ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
    )
    assert provider.epoch == 2
    assert service.session.delegate_state("d-1") == "completed"
    assert provider.injected[-1].kind == "recovery"


@pytest.mark.asyncio
async def test_final_user_transcript_enters_runtime_as_user_input() -> None:
    service, _provider, runtime, _frames = make_service()
    await service.connect()

    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="user-item", text="继续实现")
    )

    assert runtime.posted == [UserInput(text="继续实现")]


@pytest.mark.asyncio
async def test_service_records_provider_and_host_item_telemetry() -> None:
    records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            records.append((kind, payload))

    service, _provider, runtime, _frames = make_service(telemetry=_Telemetry())
    await service.connect()
    service.session.register_delegate("d-1", summary="实现任务", state="running")

    assert runtime.observer is not None
    runtime.observer(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="working",
            internal_activity=1,
            elapsed=0.5,
        )
    )
    await service.flush_host_items()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="response-1"))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="response-1", pcm=b"\x00\x01")
    )
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="response-1", pcm=b"\x00\x01")
    )

    kinds = [kind for kind, _payload in records]
    assert kinds.count("provider.response_started") == 1
    assert kinds.count("provider.first_audio_delta") == 1
    assert kinds.count("codex.progress") == 1
    assert kinds.count("hostitem.queued") == 1
    assert kinds.count("hostitem.injected") == 1
    queued = next(payload for kind, payload in records if kind == "hostitem.queued")
    injected = next(payload for kind, payload in records if kind == "hostitem.injected")
    assert queued["event_id"] == injected["event_id"]


@pytest.mark.asyncio
async def test_transcript_deltas_reach_the_caption_channel() -> None:
    """Speculative captions flow to the display side channel without touching session state."""
    captions: list[CaptionFrame] = []
    service, _provider, _runtime, _frames = make_service(captions=captions)
    await service.connect()

    await service.handle_event(ResponseStarted(session_epoch=1, response_id="response-1"))
    await service.handle_event(
        ResponseTranscriptDelta(session_epoch=1, response_id="response-1", text="正在")
    )

    assert captions == [CaptionFrame(role="assistant", text="正在", final=False)]


@pytest.mark.asyncio
async def test_replayed_user_transcript_commits_only_once() -> None:
    """A duplicated provider transcript item must not become two authoritative user inputs."""
    service, _provider, runtime, _frames = make_service()
    await service.connect()

    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="user-item", text="继续实现")
    )
    await service.handle_event(
        UserTranscriptFinal(session_epoch=1, item_id="user-item", text="继续实现")
    )
    await service.handle_event(
        UserTranscriptFinal(session_epoch=2, item_id="stale-item", text="stale epoch")
    )

    assert runtime.posted == [UserInput(text="继续实现")]


@pytest.mark.asyncio
async def test_stale_user_hold_releases_host_delivery() -> None:
    """A lost provider speech-end must not permanently starve Codex fact delivery."""
    clock = VirtualClock()
    service, provider, runtime, _frames = make_service(clock=clock)
    await service.connect()
    service.session.register_delegate("d-1", summary="实现任务", state="running")
    await service.handle_event(
        UserSpeechStarted(session_epoch=1, speech_id="speech-user", provider_item_id="user-item")
    )
    assert service.session.floor.state == "user_speaking"

    assert runtime.observer is not None
    runtime.observer(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="working",
            internal_activity=1,
            elapsed=0.5,
        )
    )
    await service.flush_host_items()
    assert provider.injected == []

    clock.advance_to(31.0)
    await service.flush_host_items()

    assert [item.kind for item in provider.injected] == ["progress"]
    assert service.session.floor.state == "idle"


@pytest.mark.asyncio
async def test_provider_terminal_is_forwarded_with_nova_audio_agent_playback_identity() -> None:
    terminals: list[tuple[str, int]] = []
    service, _provider, _runtime, _frames = make_service(terminals=terminals)
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="foreground"))
    await service.handle_event(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="foreground",
            pcm=b"\x00\x01",
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="foreground",
            status="completed",
            reason="completed",
        )
    )

    assert terminals == [("utterance-progress", 1)]


@pytest.mark.asyncio
async def test_renderer_stop_fences_response_and_releases_host_delivery() -> None:
    service, provider, runtime, _frames = make_service()
    await service.connect()
    service.session.register_delegate("d-1", summary="实现任务", state="running")
    assert runtime.observer is not None
    runtime.observer(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="working",
            internal_activity=1,
            elapsed=0.5,
        )
    )
    await service.flush_host_items()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="response-1"))
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id="response-1", pcm=b"\x00\x01")
    )
    generation = service.session.current_generation
    assert generation is not None

    assert await service.playback_stopped(
        generation.utterance_id,
        generation.generation_epoch,
    )

    assert service.session.current_generation is None
    assert provider.actions[-3:] == [
        "clear:utterance-progress:1",
        "delivery:suppressed:",
        "cancel:response-1",
    ]


@pytest.mark.asyncio
async def test_started_receive_loop_recovers_transient_output_injection_on_replay() -> None:
    """Letting provider I/O escape the receive task kills later fast-brain events."""
    service, provider, _runtime, _frames = make_service()
    provider.inject_failures = 1
    event = ToolCallReady(
        session_epoch=1,
        call_id="call-1",
        item_id="item-1",
        name="codex__run",
        arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
        response_id="tool-response",
    )
    first_attempt_finished = asyncio.Event()
    allow_replay = asyncio.Event()
    replay_finished = asyncio.Event()

    async def replaying_events():
        yield event
        first_attempt_finished.set()
        await allow_replay.wait()
        yield event
        replay_finished.set()
        await asyncio.Event().wait()

    provider.events = replaying_events  # type: ignore[method-assign]
    await service.start()
    try:
        await wait_for_stream_advance_without_service_stop(service, first_attempt_finished)
        bridge = service._bridge
        assert isinstance(bridge, FakeBridge)
        assert provider.inject_attempts == 1
        assert provider.injected == []
        assert len(bridge.calls) == 1

        allow_replay.set()
        await wait_for_stream_advance_without_service_stop(service, replay_finished)

        assert provider.inject_attempts == 2
        assert len(provider.injected) == 1
        assert len(provider.response_intents) == 1
        assert len(bridge.calls) == 1
    finally:
        allow_replay.set()
        await service.close()


@pytest.mark.asyncio
async def test_started_receive_loop_recovers_transient_response_request_on_replay() -> None:
    """A failed response request must stay queued without stopping or eager retrying."""
    service, provider, _runtime, _frames = make_service()
    provider.response_failures = 1
    event = ToolCallReady(
        session_epoch=1,
        call_id="call-1",
        item_id="item-1",
        name="codex__run",
        arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
        response_id="tool-response",
    )
    first_attempt_finished = asyncio.Event()
    allow_replay = asyncio.Event()
    replay_finished = asyncio.Event()

    async def replaying_events():
        yield event
        first_attempt_finished.set()
        await allow_replay.wait()
        yield event
        replay_finished.set()
        await asyncio.Event().wait()

    provider.events = replaying_events  # type: ignore[method-assign]
    await service.start()
    try:
        await wait_for_stream_advance_without_service_stop(service, first_attempt_finished)
        bridge = service._bridge
        assert isinstance(bridge, FakeBridge)
        assert provider.actions.count("create_response") == 1
        assert provider.response_intents == []
        assert len(provider.injected) == 1
        assert len(bridge.calls) == 1

        allow_replay.set()
        await wait_for_stream_advance_without_service_stop(service, replay_finished)

        assert provider.actions.count("create_response") == 2
        assert len(provider.response_intents) == 1
        assert len(provider.injected) == 1
        assert len(bridge.calls) == 1
    finally:
        allow_replay.set()
        await service.close()


@pytest.mark.asyncio
async def test_unexpected_receive_task_failure_stops_service() -> None:
    service, provider, _runtime, _frames = make_service()

    async def failing_events():
        raise RuntimeError("receive failed")
        yield  # pragma: no cover

    provider.events = failing_events  # type: ignore[method-assign]
    await service.start()

    await asyncio.wait_for(service.wait_stopped(), timeout=0.2)
    await service.close()


@pytest.mark.asyncio
async def test_unexpected_receive_task_completion_stops_service() -> None:
    service, _provider, _runtime, _frames = make_service()

    await service.start()

    await asyncio.wait_for(service.wait_stopped(), timeout=0.2)
    await service.close()


@pytest.mark.asyncio
async def test_reconnect_clears_stale_captions() -> None:
    """Dead-epoch caption text must be blanked when the provider session is replaced."""
    captions: list[CaptionFrame] = []
    service, _provider, _runtime, _frames = make_service(captions=captions)
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="response-1"))
    await service.handle_event(
        ResponseTranscriptDelta(session_epoch=1, response_id="response-1", text="旧字幕")
    )
    assert captions
    captions.clear()

    await service.handle_event(
        ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
    )

    assert CaptionFrame(role="assistant", text="", final=True) in captions
    assert CaptionFrame(role="user", text="", final=True) in captions


@pytest.mark.asyncio
async def test_blocked_host_item_self_wakes_at_the_stale_hold_deadline() -> None:
    """The last queued item must not starve when the provider never sends speech-end."""
    clock = VirtualClock()
    service, provider, runtime, _frames = make_service(clock=clock)
    await service.connect()
    service.session.register_delegate("d-1", summary="实现任务", state="running")
    await service.handle_event(
        UserSpeechStarted(session_epoch=1, speech_id="speech-user", provider_item_id="user-item")
    )

    assert runtime.observer is not None
    runtime.observer(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="working",
            internal_activity=1,
            elapsed=0.5,
        )
    )
    await service.flush_host_items()
    assert provider.injected == []

    for _ in range(3):
        await asyncio.sleep(0)
    clock.advance_to(31.0)
    for _ in range(10):
        await asyncio.sleep(0)

    assert [item.kind for item in provider.injected] == ["progress"]
    assert service.session.floor.state == "idle"


@pytest.mark.asyncio
async def test_stale_hold_wake_retries_delivery_error_without_stopping_service() -> None:
    """A transient response.create failure after stale release must not kill the session."""
    clock = VirtualClock()
    service, provider, runtime, _frames = make_service(clock=clock)
    provider.response_failures = 1
    await service.connect()
    service.session.register_delegate("d-1", summary="实现任务", state="running")
    await service.handle_event(
        UserSpeechStarted(session_epoch=1, speech_id="speech-user", provider_item_id="user-item")
    )

    assert runtime.observer is not None
    runtime.observer(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="working",
            internal_activity=1,
            elapsed=0.5,
        )
    )
    await service.flush_host_items()

    for _ in range(3):
        await asyncio.sleep(0)
    clock.advance_to(31.0)
    for _ in range(10):
        await asyncio.sleep(0)

    assert not service._stop.is_set()
    assert provider.actions.count("create_response") == 1
    assert len(provider.injected) == 1

    clock.advance_to(32.1)
    for _ in range(10):
        await asyncio.sleep(0)

    assert not service._stop.is_set()
    assert provider.actions.count("create_response") == 2
    assert len(provider.response_intents) == 1
    assert len(provider.injected) == 1


@pytest.mark.asyncio
async def test_progress_summary_renders_natural_fact_and_skips_identical_summaries() -> None:
    """R103: a summarized progress speaks naturally once; identical summaries never re-inject."""
    service, provider, runtime, _frames = make_service()
    await service.connect()
    service.session.register_delegate("d-1", summary="实现俄罗斯方块", state="running")

    assert runtime.observer is not None
    summary = "已执行 3 条命令（1 条失败）。正在实现方块旋转"
    runtime.observer(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="working",
            internal_activity=3,
            elapsed=41.2,
            summary=summary,
        )
    )
    await service.flush_host_items()

    assert provider.injected[-1].kind == "progress"
    content = provider.injected[-1].content
    assert content == f"Codex 正在执行：{summary}（已进行41秒）"
    assert "phase=" not in content
    assert "internal_activity" not in content
    assert "elapsed" not in content
    await complete_audible_response(service, "progress-response")

    runtime.observer(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="working",
            internal_activity=5,
            elapsed=71.0,
            summary=summary,
        )
    )
    await service.flush_host_items()

    assert [item.kind for item in provider.injected].count("progress") == 1
    record = dict(service.session.snapshot().active_delegates)["d-1"]
    assert record.progress_summary == summary
    assert record.internal_activity == 5
    assert record.elapsed == 71.0

    runtime.observer(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="working",
            internal_activity=7,
            elapsed=101.0,
            summary="已执行 5 条命令。开始编写测试",
        )
    )
    await service.flush_host_items()

    assert [item.kind for item in provider.injected].count("progress") == 2
    assert "开始编写测试" in provider.injected[-1].content


@pytest.mark.asyncio
async def test_progress_without_summary_uses_natural_speech_and_is_not_deduped() -> None:
    service, provider, runtime, _frames = make_service()
    await service.connect()
    service.session.register_delegate("d-1", summary="实现俄罗斯方块", state="running")

    assert runtime.observer is not None
    runtime.observer(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="working",
            internal_activity=1,
            elapsed=0.5,
        )
    )
    await service.flush_host_items()

    assert provider.injected[-1].content == "Codex 仍在处理这个任务，目前已推进 1 个步骤。"
    assert "phase=" not in provider.injected[-1].content
    assert "internal_activity" not in provider.injected[-1].content
    assert "elapsed=" not in provider.injected[-1].content
    await complete_audible_response(service, "progress-response")

    runtime.observer(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="working",
            internal_activity=2,
            elapsed=31.0,
        )
    )
    await service.flush_host_items()

    assert [item.kind for item in provider.injected].count("progress") == 2


@pytest.mark.asyncio
async def test_codex_progress_telemetry_never_records_the_summary() -> None:
    records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            records.append((kind, payload))

    service, _provider, runtime, _frames = make_service(telemetry=_Telemetry())
    await service.connect()
    service.session.register_delegate("d-1", summary="实现任务", state="running")

    assert runtime.observer is not None
    runtime.observer(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="working",
            internal_activity=1,
            elapsed=0.5,
            summary="摘要哨兵不入遥测",
        )
    )

    payload = next(payload for kind, payload in records if kind == "codex.progress")
    assert set(payload) == {"delegate_id", "phase", "internal_activity"}
    assert "摘要哨兵不入遥测" not in json.dumps(payload, ensure_ascii=False)


async def test_final_host_fact_extracts_speech_view_instead_of_envelope() -> None:
    """R104: the final host fact carries a speech-prepared view, never the JSON envelope."""
    service, provider, runtime, _frames = make_service()
    await service.connect()
    service.session.register_delegate("d-1", summary="实现俄罗斯方块", state="running")

    assert runtime.observer is not None
    event = HandoffEvent(
        channel="codex",
        delegate_id="d-1",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={
            "op": "run",
            "worker": "codex",
            "code": "completed",
            "events": [{"type": "turn.completed"}],
            "protocol": {"terminal": "completed"},
            "process": {"exit_code": 0},
            "preflight": {"version": "0.145.0"},
            "result": {
                "final_message": {
                    "text": (
                        "已创建 [tetris.py](/Users/someone/ws/tetris.py)。"
                        "运行方式： ```bash python3 tetris.py ``` 按 `R` 重新开始。"
                    ),
                    "original_chars": 80,
                    "truncated": False,
                    "sha256": "af8a7d2c440a3463f6df0188beae281fae9685d7"
                    "0e1d2f1460186b480ff52aabbccdd11",
                }
            },
        },
    )
    project_claimed_handoff(service, runtime, event, op="run")
    await service.flush_host_items()

    assert provider.injected[-1].kind == "final"
    content = provider.injected[-1].content
    assert content.startswith("Codex 报告任务完成：")
    assert "tetris.py" in content
    assert "（代码示例略）" in content
    for forbidden in ("{", '"outcome"', "sha256", "exit_code", "preflight", "```", "]("):
        assert forbidden not in content
    assert len(content) <= MAX_HOST_FACT_CHARS


async def test_final_host_fact_unknown_outcome_and_truncation_note() -> None:
    service, provider, runtime, _frames = make_service()
    await service.connect()
    service.session.register_delegate("d-1", summary="实现任务", state="running")

    assert runtime.observer is not None
    event = HandoffEvent(
        channel="codex",
        delegate_id="d-1",
        origin_ref="conversation:1",
        outcome="unknown",
        trust="trusted_system",
        content={
            "result": {
                "final_message": {
                    "text": "结果待确认。",
                    "original_chars": 9000,
                    "truncated": True,
                    "sha256": "00" * 32,
                }
            }
        },
    )
    project_claimed_handoff(service, runtime, event, op="run")
    await service.flush_host_items()

    content = provider.injected[-1].content
    assert content.startswith("Codex 任务结果不确定：")
    assert "结果待确认" in content
    assert "（结果较长，已截取要点）" in content


async def test_final_host_fact_without_final_message_reports_code_category() -> None:
    service, provider, runtime, _frames = make_service()
    await service.connect()
    service.session.register_delegate("d-1", summary="实现任务", state="running")

    assert runtime.observer is not None
    event = HandoffEvent(
        channel="codex",
        delegate_id="d-1",
        origin_ref="conversation:1",
        outcome="failed",
        trust="trusted_system",
        content={"code": "sandbox_denied", "process": {"exit_code": 1}},
    )
    project_claimed_handoff(service, runtime, event, op="run")
    await service.flush_host_items()

    content = provider.injected[-1].content
    assert content == "Codex 任务未能确认完成（sandbox_denied）"
    assert "exit_code" not in content


async def test_final_host_fact_event_id_and_dedup_unchanged() -> None:
    service, provider, runtime, _frames = make_service()
    await service.connect()
    service.session.register_delegate("d-1", summary="实现任务", state="running")

    assert runtime.observer is not None
    event = HandoffEvent(
        channel="codex",
        delegate_id="d-1",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={"result": {"final_message": {"text": "完成。", "truncated": False}}},
    )
    project_claimed_handoff(service, runtime, event, op="run")
    await service.flush_host_items()
    await complete_audible_response(service, "final-response")
    project_claimed_handoff(service, runtime, event, op="run")
    await service.flush_host_items()

    finals = [item for item in provider.injected if item.kind == "final"]
    assert len(finals) == 1
    assert finals[0].event_id == "final:d-1"


async def test_progress_summary_passes_through_speech_prep() -> None:
    """R104 x R103: a markdown-bearing progress summary is speech-prepped before injection."""
    service, provider, runtime, _frames = make_service()
    await service.connect()
    service.session.register_delegate("d-1", summary="实现任务", state="running")

    assert runtime.observer is not None
    runtime.observer(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="working",
            internal_activity=2,
            elapsed=31.0,
            summary="正在写 `tetris.py`，参考 [文档](https://example.com/doc)",
        )
    )
    await service.flush_host_items()

    content = provider.injected[-1].content
    assert content.startswith("Codex 正在执行：")
    assert "`" not in content
    assert "](" not in content
    assert "example.com" not in content
    assert "tetris.py" in content


async def test_observer_boundary_rejects_invalid_summary_shapes() -> None:
    """CP1: the service must not trust observer events past the runtime validator.

    _process_event notifies observers unconditionally, so an event whose summary
    violates R103 shape (dropped from Memory) still reaches this boundary. It must
    fall back to natural bounded speech and must not crash host-item construction."""
    service, provider, runtime, _frames = make_service()
    await service.connect()
    service.session.register_delegate("d-1", summary="实现任务", state="running")

    assert runtime.observer is not None
    for bad_summary, activity in (
        ("x" * 5000, 1),  # would raise in HostContextItem construction if trusted
        ("控制\x00符", 2),
        ("", 3),
    ):
        runtime.observer(
            ProgressEvent(
                channel="codex",
                delegate_id="d-1",
                op="run",
                phase="working",
                internal_activity=activity,
                elapsed=1.0,
                summary=bad_summary,
            )
        )
    await service.flush_host_items()

    progress_items = [item for item in provider.injected if item.kind == "progress"]
    assert progress_items
    for item in progress_items:
        assert item.content.startswith("Codex 仍在处理这个任务，目前已推进 ")
        assert "phase=" not in item.content
        assert "internal_activity" not in item.content
        assert "elapsed=" not in item.content
        assert "x" * 401 not in item.content
        assert "\x00" not in item.content
    record = dict(service.session.snapshot().active_delegates)["d-1"]
    assert record.progress_summary is None


async def test_handoff_clears_progress_summary_dedup_state() -> None:
    """CP1: a completed delegate must not leave dedup residue behind."""
    service, provider, runtime, _frames = make_service()
    await service.connect()
    service.session.register_delegate("d-1", summary="实现任务", state="running")

    assert runtime.observer is not None
    runtime.observer(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="working",
            internal_activity=1,
            elapsed=1.0,
            summary="第一次摘要",
        )
    )
    event = HandoffEvent(
        channel="codex",
        delegate_id="d-1",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={"result": {"final_message": {"text": "完成。", "truncated": False}}},
    )
    project_claimed_handoff(service, runtime, event, op="run")
    assert service._last_progress_summary == {}


async def test_final_host_fact_failed_with_final_message_keeps_code_category() -> None:
    """CP2: `failed` must stay distinct from `unknown` and keep its code category."""
    service, provider, runtime, _frames = make_service()
    await service.connect()
    service.session.register_delegate("d-1", summary="实现任务", state="running")

    assert runtime.observer is not None
    event = HandoffEvent(
        channel="codex",
        delegate_id="d-1",
        origin_ref="conversation:1",
        outcome="failed",
        trust="trusted_system",
        content={
            "code": "worker_failed",
            "result": {"final_message": {"text": "部分结果仍可使用。", "truncated": False}},
        },
    )
    project_claimed_handoff(service, runtime, event, op="run")
    await service.flush_host_items()

    content = provider.injected[-1].content
    assert content == "Codex 任务失败（worker_failed）：部分结果仍可使用。"
    assert "结果不确定" not in content


async def test_recovery_frame_progress_is_speech_prepped() -> None:
    """CP2: the recovery frame renders the stored summary, so markdown must be
    stripped at the storage boundary, not only at injection."""
    service, _provider, runtime, _frames = make_service()
    await service.connect()
    service.session.register_delegate("d-1", summary="实现任务", state="running")

    assert runtime.observer is not None
    runtime.observer(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="working",
            internal_activity=1,
            elapsed=5.0,
            summary="正在写 `tetris.py`，参考 [文档](https://example.com/doc)",
        )
    )
    record = dict(service.session.snapshot().active_delegates)["d-1"]
    assert record.progress_summary is not None
    assert "`" not in record.progress_summary
    assert "](" not in record.progress_summary
    assert "example.com" not in record.progress_summary
    assert "tetris.py" in record.progress_summary


async def test_external_delegate_started_keeps_one_notification() -> None:
    """Review regression: #49 dedup applies only to realtime delegates that
    own an acknowledgement continuation; external work still needs a start fact."""
    service, provider, runtime, _frames = make_service()
    await service.connect()
    service.session.register_delegate("d-1", summary="实现任务", state="running")

    assert runtime.observer is not None
    runtime.observer(
        ProgressEvent(
            channel="codex",
            delegate_id="d-1",
            op="run",
            phase="started",
            internal_activity=0,
            elapsed=0.0,
            summary="started 不该带摘要",
        )
    )
    await service.flush_host_items()

    progress_items = [item for item in provider.injected if item.kind == "progress"]
    assert [item.content for item in progress_items] == ["Codex 已开始处理这个任务。"]
    record = dict(service.session.snapshot().active_delegates)["d-1"]
    assert record.progress_summary is None


# ---- R105: synchronous tool results for fast readonly ops ----


SEARCH_HANDOFF_CONTENT = {
    "provider": "tavily",
    "query": "北京天气",
    "query_ref": "web.search://query/1111",
    "fetched_at": 12.5,
    "provider_request_id": "req-provider-42",
    "results": [
        {
            "rank": 1,
            "title": "北京今日天气",
            "source_label": "weather.com.cn",
            "snippet": "北京今天晴，最高气温 25 度。",
            "canonical_url": "https://www.weather.com.cn/beijing",
            "content_digest": "a" * 64,
            "evidence_ref": "web.search://evidence/2222",
        }
    ],
}


def sync_acceptance_for(call_id: str, *, event_id: str, delegate_id: str) -> ToolAcceptance:
    item = HostContextItem.tool_output(
        host_item_id=f"host-{event_id}",
        event_id=event_id,
        call_id=call_id,
        content='{"state":"pending"}',
    )
    return ToolAcceptance(
        accepted=True,
        code="accepted",
        delegate_id=delegate_id,
        host_item=item,
        response_intent=HostResponseIntent.tool_result(item),
        sync_result=True,
        executor="search",
    )


@pytest.mark.asyncio
async def test_sync_codex_status_does_not_reserve_background_acknowledgement() -> None:
    """Manifest semantics, not the codex name prefix, choose the continuation path."""
    service, _provider, _runtime, _frames = make_service()
    service._tools = CompiledTools(
        schemas=(),
        bindings={
            "codex__status": ToolBinding(
                kind="delegate",
                logical_name="codex.status",
                executor="codex",
                op="status",
                sync_result=True,
            )
        },
    )
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    bridge.acceptance = sync_acceptance_for(
        "call-status",
        event_id="event-status",
        delegate_id="d-status",
    )
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id="status-response"))

    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-status",
            item_id="item-status",
            name="codex__status",
            arguments={"origin_ref": "conversation:1"},
            response_id="status-response",
        )
    )

    assert service._semantic_acknowledgement_reservations == 0
    assert service._pending_sync == {"d-status": (1, "call-status")}
    assert service.session.snapshot().active_delegates == ()


def search_handoff(delegate_id: str) -> HandoffEvent:
    return HandoffEvent(
        channel="search",
        delegate_id=delegate_id,
        origin_ref="conversation:1",
        outcome="ok",
        trust="untrusted_external",
        content=SEARCH_HANDOFF_CONTENT,
    )


async def begin_sync_search_call(
    service: RealtimeService,
    *,
    response_id: str = "search-response",
) -> None:
    bridge = service._bridge
    assert isinstance(bridge, FakeBridge)
    bridge.acceptance = sync_acceptance_for(
        "call-search",
        event_id="event-search",
        delegate_id="d-search",
    )
    await service.handle_event(ResponseStarted(session_epoch=1, response_id=response_id))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id="call-search",
            item_id="item-search",
            name="search__search",
            arguments={"query": "北京天气", "k": 3, "origin_ref": "conversation:1"},
            response_id=response_id,
        )
    )


@pytest.mark.asyncio
async def test_sync_tool_result_holds_continuation_until_handoff_resolves() -> None:
    """R105 happy path: the batch stays unready while the sync output is pending, then
    the handoff confirms a compact model-grounding view with no internal refs."""
    service, provider, runtime, _frames = make_service()
    await service.connect()
    await begin_sync_search_call(service)
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="search-response",
            status="completed",
            reason="completed",
        )
    )

    assert provider.injected == []
    assert provider.actions.count("create_response") == 0

    assert runtime.observer is not None
    runtime.observer(search_handoff("d-search"))
    await service.flush_host_items()
    await service._drive_continuations()

    assert [item.call_id for item in provider.injected] == ["call-search"]
    content = provider.injected[0].content
    payload = json.loads(content)
    assert payload["state"] == "ok"
    assert payload["query"] == "北京天气"
    assert payload["results"] == [
        {
            "title": "北京今日天气",
            "snippet": "北京今天晴，最高气温 25 度。",
            "source": "www.weather.com.cn",
        }
    ]
    assert "query_ref" not in content
    assert "evidence_ref" not in content
    assert "provider_request_id" not in content
    assert "content_digest" not in content
    assert provider.actions.count("create_response") == 1
    assert provider.response_intents[-1].kind == "tool_result"
    assert len(service._host_items) == 0


@pytest.mark.asyncio
async def test_sync_tool_deadline_resolves_timeout_and_late_handoff_becomes_one_host_fact() -> None:
    """R105 timeout: Deadline first confirms a typed timeout and the turn proceeds; the
    late handoff downgrades to exactly one deduplicated host fact."""
    service, provider, runtime, _frames = make_service()
    await service.connect()
    await begin_sync_search_call(service)
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="search-response",
            status="completed",
            reason="completed",
        )
    )

    assert runtime.observer is not None
    runtime.observer(Deadline(delegate_id="d-search"))
    await service.flush_host_items()
    await service._drive_continuations()

    assert [item.call_id for item in provider.injected] == ["call-search"]
    assert provider.injected[0].content == '{"state":"timeout"}'
    assert provider.actions.count("create_response") == 1
    assert len(service._host_items) == 0

    runtime.observer(search_handoff("d-search"))

    assert len(service._host_items) == 1
    queued = service._host_items[0].intent
    assert queued.kind == "host_fact"
    assert queued.item.kind == "final"
    assert queued.item.event_id == "sync:d-search"
    assert "北京今日天气" in queued.item.content
    assert "query_ref" not in queued.item.content
    assert "evidence_ref" not in queued.item.content

    runtime.observer(search_handoff("d-search"))

    assert len(service._host_items) == 1
    assert provider.actions.count("create_response") == 1


@pytest.mark.asyncio
async def test_barge_in_converts_pending_sync_to_announce_host_fact_without_continuation() -> None:
    """R105 fallback: a cancelled origin abandons the batch; the sync result arrives as an
    ordinary host fact, never as a continuation into the dead turn."""
    service, provider, runtime, _frames = make_service()
    await service.connect()
    await begin_sync_search_call(service)
    await service.handle_event(
        UserSpeechStarted(session_epoch=1, speech_id="speech-user", provider_item_id="user-item")
    )
    await service.local_speech_onset("speech-local-uuid")
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="search-response",
            status="cancelled",
            reason="turn_detected",
        )
    )

    assert [item.content for item in provider.injected] == ['{"state":"pending"}']
    assert provider.actions.count("create_response") == 0
    assert len(service._host_items) == 0

    assert runtime.observer is not None
    runtime.observer(search_handoff("d-search"))

    assert len(service._host_items) == 1
    queued = service._host_items[0].intent
    assert queued.kind == "host_fact"
    assert queued.item.event_id == "sync:d-search"
    assert "北京今日天气" in queued.item.content

    runtime.observer(search_handoff("d-search"))

    assert len(service._host_items) == 1
    assert provider.actions.count("create_response") == 0


@pytest.mark.asyncio
async def test_reconnect_converts_pending_sync_to_announce_in_new_epoch() -> None:
    """R105 epoch change: a pending sync member survives reconnect as the announce path;
    the result becomes a host fact in the new epoch, never a cross-epoch continuation."""
    service, provider, runtime, _frames = make_service()
    await service.connect()
    await begin_sync_search_call(service)
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="search-response",
            status="completed",
            reason="completed",
        )
    )
    assert provider.injected == []

    await service.handle_event(
        ProviderErrorEvent(session_epoch=1, code="disconnected", recoverable=True)
    )

    assert provider.epoch == 2
    assert all(item.call_id != "call-search" for item in provider.injected)
    assert provider.actions.count("create_response") == 0

    assert runtime.observer is not None
    runtime.observer(search_handoff("d-search"))

    assert len(service._host_items) == 1
    queued = service._host_items[0].intent
    assert queued.kind == "host_fact"
    assert queued.item.event_id == "sync:d-search"

    await service.flush_host_items()

    assert all(item.call_id != "call-search" for item in provider.injected)
    assert provider.response_intents[-1].kind == "host_fact"
    assert provider.response_epochs[-1] == 2
    assert len(service._host_items) == 0


@pytest.mark.asyncio
async def test_sync_resolution_is_idempotent_across_handoff_then_deadline() -> None:
    """R105: the first event wins; a later Deadline or repeated handoff for the same
    delegate is a no-op."""
    service, provider, runtime, _frames = make_service()
    await service.connect()
    await begin_sync_search_call(service)
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="search-response",
            status="completed",
            reason="completed",
        )
    )

    assert runtime.observer is not None
    runtime.observer(search_handoff("d-search"))
    await service.flush_host_items()
    await service._drive_continuations()

    assert [item.call_id for item in provider.injected] == ["call-search"]
    assert json.loads(provider.injected[0].content)["state"] == "ok"
    assert provider.actions.count("create_response") == 1

    runtime.observer(Deadline(delegate_id="d-search"))
    await service.flush_host_items()
    await service._drive_continuations()
    runtime.observer(search_handoff("d-search"))

    assert [item.call_id for item in provider.injected] == ["call-search"]
    assert json.loads(provider.injected[0].content)["state"] == "ok"
    assert provider.actions.count("create_response") == 1
    assert len(service._host_items) == 0


@pytest.mark.asyncio
async def test_sync_resolution_drives_exactly_one_continuation_across_both_entry_points() -> None:
    """R105 interleaving: resolution wakes the delivery loop, and a provider event racing
    it must not request a second continuation."""
    service, provider, runtime, _frames = make_service()
    await service.connect()
    await begin_sync_search_call(service)
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="search-response",
            status="completed",
            reason="completed",
        )
    )

    delivery = asyncio.create_task(service._delivery_loop())
    try:
        assert runtime.observer is not None
        runtime.observer(search_handoff("d-search"))
        for _ in range(50):
            await asyncio.sleep(0)
            if provider.actions.count("create_response"):
                break
    finally:
        service._stop.set()
        service._delivery_ready.set()
        await delivery
    service._stop.clear()

    assert provider.actions.count("create_response") == 1

    await service.handle_event(UserSpeechStarted(session_epoch=1, speech_id="speech-race"))
    await service._drive_continuations()

    assert [item.call_id for item in provider.injected] == ["call-search"]
    assert provider.actions.count("create_response") == 1


async def test_concurrent_drive_entry_points_request_exactly_one_continuation() -> None:
    """CP3 blocker: with a provider that yields, two drivers could both pass the
    requested/bound guard while the batch was still ready, double-injecting the
    output and creating two continuation responses."""
    service, provider, runtime, _frames = make_service()
    await service.connect()
    await begin_sync_search_call(service)

    original_inject = provider.inject_host_item
    original_create = provider.create_response

    async def yielding_inject(item):  # noqa: ANN001, ANN202
        await asyncio.sleep(0)
        return await original_inject(item)

    async def yielding_create(intent):  # noqa: ANN001, ANN202
        await asyncio.sleep(0)
        return await original_create(intent)

    provider.inject_host_item = yielding_inject
    provider.create_response = yielding_create

    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="search-response",
            status="completed",
            reason="completed",
        )
    )
    assert runtime.observer is not None
    runtime.observer(search_handoff("d-search"))

    await asyncio.gather(service._drive_continuations(), service._drive_continuations())

    assert [item.call_id for item in provider.injected] == ["call-search"]
    assert provider.actions.count("create_response") == 1


async def test_resolved_sync_result_survives_batch_abandonment_as_host_fact() -> None:
    """CP3: a handoff resolved while the origin is still collecting must not be
    lost when the user then barges in — it downgrades to one host fact."""
    service, provider, runtime, _frames = make_service()
    await service.connect()
    await begin_sync_search_call(service)

    assert runtime.observer is not None
    runtime.observer(search_handoff("d-search"))

    await service.handle_event(
        UserSpeechStarted(session_epoch=1, speech_id="speech-user", provider_item_id="user-item")
    )
    await service.local_speech_onset("speech-local-uuid")
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="search-response",
            status="cancelled",
            reason="turn_detected",
        )
    )

    assert provider.actions.count("create_response") == 0
    facts = [queued for queued in service._host_items if queued.intent.kind == "host_fact"]
    assert len(facts) == 1
    assert facts[0].intent.item.event_id == "sync:d-search"
    assert "北京今日天气" in facts[0].intent.item.content


async def test_pruned_announce_state_still_announces_the_late_result() -> None:
    """CP3: pruning a terminal-disposition call must not swallow the delegate's
    still-outstanding result."""
    service, provider, runtime, _frames = make_service()
    await service.connect()
    await begin_sync_search_call(service)
    await service.handle_event(
        UserSpeechStarted(session_epoch=1, speech_id="speech-user", provider_item_id="user-item")
    )
    await service.local_speech_onset("speech-local-uuid")
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id="search-response",
            status="cancelled",
            reason="turn_detected",
        )
    )
    assert "d-search" in service._pending_sync

    service._prune_terminal_tool_state()

    assert runtime.observer is not None
    runtime.observer(search_handoff("d-search"))

    facts = [queued for queued in service._host_items if queued.intent.kind == "host_fact"]
    assert len(facts) == 1
    assert facts[0].intent.item.event_id == "sync:d-search"

    runtime.observer(search_handoff("d-search"))
    assert len([queued for queued in service._host_items if queued.intent.kind == "host_fact"]) == 1


async def test_sync_result_content_stays_valid_json_at_max_legal_input() -> None:
    """P1: clamping serialized JSON with [:3000] produced unterminated strings at
    legal-maximum input (512-char query, 5 results, 120/400 title/snippet)."""
    service, _provider, runtime, _frames = make_service()
    await service.connect()

    event = HandoffEvent(
        channel="search",
        delegate_id="d-search",
        origin_ref="conversation:1",
        outcome="ok",
        trust="untrusted_external",
        content={
            "provider": "tavily",
            "query": "天" * 512,
            "query_ref": "web.search://query/9999",
            "fetched_at": 12.0,
            "provider_request_id": "req-max",
            "results": [
                {
                    "title": "标" * 300,
                    "snippet": "摘" * 2000,
                    "canonical_url": f"https://example{index}.com/very/long/path",
                    "evidence_ref": f"web.search://evidence/{index}",
                    "content_digest": "a" * 64,
                }
                for index in range(5)
            ],
        },
    )
    encoded = service._sync_result_content(event)

    assert len(encoded) <= MAX_HOST_FACT_CHARS
    view = json.loads(encoded)
    assert view["state"] == "ok"
    assert view["results"], "shrinking must retain at least one result"
    for result in view["results"]:
        assert "evidence_ref" not in result
    assert "query_ref" not in view
