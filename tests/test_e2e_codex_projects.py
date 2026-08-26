from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass
from itertools import count
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from pydantic import SecretStr
import pytest

import nova_audio_agent.assembly as assembly_module
import nova_audio_agent.realtime.qwen as qwen_module
from nova_audio_agent.assembly import RealtimeAssembly, build_qwen_realtime_assembly
from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.config import Settings
from nova_audio_agent.executors.codex import CodexProcessStatus, CodexTransportResult
from nova_audio_agent.executors.codex_app_server import SteerTransportResult
from nova_audio_agent.executors.codex_project_live import (
    ProjectCodexAdapter,
    ProjectCommitResult,
    RuntimeDispatch,
)
from nova_audio_agent.executors.codex_projects import CodexProjectStore, ProjectStateError
from nova_audio_agent.realtime.desktop import codex_project_message
from nova_audio_agent.realtime.project_confirmation import (
    ConfirmedProjectOperation,
    ProjectConfirmationController,
)
from nova_audio_agent.realtime.protocol import (
    HostContextItem,
    HostResponseIntent,
    ItemIdentity,
    RealtimeFrontBrainEvent,
    ResponseStarted,
    SessionIdentity,
    ToolCallReady,
    UserSpeechEnded,
    UserSpeechStarted,
    UserTranscriptFinal,
    WorkspaceContextDelivery,
    WorkspaceContextDeliveryRecord,
)


def _store(tmp_path: Path, ids: list[str], clock: VirtualClock) -> CodexProjectStore:
    values = iter(ids)
    return CodexProjectStore(
        tmp_path / "state",
        tmp_path / "managed",
        now=clock.now,
        id_factory=values.__next__,
    )


class _Sink:
    def emit(self, utterance_id: str, text: str) -> None:
        del utterance_id, text

    def end(self, utterance_id: str) -> None:
        del utterance_id


class _Provider:
    def __init__(self) -> None:
        self.epoch = 0
        self.connected_tools: list[tuple[dict[str, object], ...]] = []
        self.injected: list[HostContextItem] = []
        self.workspace_contexts: list[WorkspaceContextDeliveryRecord] = []
        self._workspace_provider_item_id: str | None = None

    async def connect(self, *, tools: tuple[dict[str, object], ...]) -> SessionIdentity:
        self.epoch += 1
        self.connected_tools.append(tools)
        return SessionIdentity(self.epoch, f"provider-{self.epoch}")

    async def send_audio(self, pcm: bytes) -> None:
        del pcm

    async def inject_host_item(
        self,
        item: HostContextItem,
        *,
        confirmation_timeout: float | None = None,
        as_user_activation: bool = False,
    ) -> ItemIdentity:
        del confirmation_timeout, as_user_activation
        self.injected.append(item)
        return ItemIdentity(self.epoch, item.host_item_id, f"provider-{item.host_item_id}")

    async def inject_workspace_context(
        self,
        item: HostContextItem,
        *,
        confirmation_timeout: float | None = None,
    ) -> WorkspaceContextDeliveryRecord:
        del confirmation_timeout
        prior = self._workspace_provider_item_id
        provider_item_id = f"provider-{item.host_item_id}"
        record = WorkspaceContextDeliveryRecord(
            item=item,
            delivery=WorkspaceContextDelivery(
                capability="replace_provider_item",
                delivered=True,
                session_epoch=self.epoch,
                workspace_instance_id=item.workspace_instance_id or "",
                revision=item.revision or 0,
                prior_provider_item_id=prior,
                provider_item_id=provider_item_id,
                superseded_provider_item_id=prior,
            ),
        )
        self._workspace_provider_item_id = provider_item_id
        self.workspace_contexts.append(record)
        return record

    async def create_response(self, intent: HostResponseIntent) -> None:
        del intent

    async def cancel_response(self, response_id: str) -> None:
        del response_id

    async def close(self) -> None:
        self._workspace_provider_item_id = None

    async def events(self) -> AsyncIterator[RealtimeFrontBrainEvent]:
        await asyncio.Event().wait()
        if False:  # pragma: no cover - makes this an async generator
            yield ResponseStarted(session_epoch=1, response_id="unused")


class _Worker:
    def __init__(self, on_ready: Callable[[str], None], work_orders: list[str]) -> None:
        self._on_ready = on_ready
        self._work_orders = work_orders

    async def preflight(self, **_kwargs: Any) -> Mapping[str, Any]:
        return {
            "version": "0.145.0",
            "root_matches": True,
            "mount": "workspace_only",
            "subprocess": "contained",
            "network": "blocked",
            "credential": {"present": True, "identity": "chatgpt", "policy": "saved_login"},
            "limits": {"cpu": "finite", "as": "finite", "nofile": "finite"},
        }

    async def prewarm(self, **_kwargs: Any) -> Mapping[str, Any]:
        return await self.preflight()

    async def run(
        self,
        work_order: str,
        *,
        on_status: Callable[[CodexProcessStatus], None],
        **_kwargs: Any,
    ) -> CodexTransportResult:
        self._work_orders.append(work_order)
        self._on_ready("thread-tetris")
        on_status(CodexProcessStatus(running=True, exited=False))
        on_status(CodexProcessStatus(running=False, exited=True, terminal="completed", exit_code=0))
        return CodexTransportResult(classification="completed", code="completed", content={})

    async def steer(self, _instruction: str) -> SteerTransportResult:
        return SteerTransportResult(code="accepted", written=True)

    async def aclose(self) -> None:
        return None


class _CountingProjectCodexAdapter(ProjectCodexAdapter):
    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.commit_calls = 0

    async def commit_confirmed(
        self,
        operation: ConfirmedProjectOperation,
        *,
        origin_ref: str,
        runtime_dispatch: RuntimeDispatch,
    ) -> ProjectCommitResult:
        self.commit_calls += 1
        return await super().commit_confirmed(
            operation,
            origin_ref=origin_ref,
            runtime_dispatch=runtime_dispatch,
        )


@dataclass(slots=True)
class _CreateHarness:
    realtime: RealtimeAssembly
    store: CodexProjectStore
    confirmation: ProjectConfirmationController
    adapter: _CountingProjectCodexAdapter
    provider: _Provider
    proposal_id: str
    worker_calls: list[str]
    work_orders: list[str]


async def _create_harness(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> _CreateHarness:
    clock = VirtualClock(start=10.0)
    managed_root = tmp_path / "managed"
    store = _store(tmp_path, ["workspace-tetris", "session-tetris"], clock)
    confirmation = ProjectConfirmationController(
        clock=clock,
        id_factory=lambda: "proposal-create-tetris",
    )
    worker_calls: list[str] = []
    work_orders: list[str] = []

    def worker_factory(
        _workspace: Path,
        _home: Path,
        _resume: str | None,
        on_ready: Callable[[str], None],
    ) -> _Worker:
        worker_calls.append("created")
        return _Worker(on_ready, work_orders)

    adapter = _CountingProjectCodexAdapter(
        store=store,
        confirmation=confirmation,
        worker_factory=worker_factory,
    )
    provider = _Provider()
    monkeypatch.setitem(assembly_module._EXECUTOR_FACTORIES, "codex", lambda _context: adapter)
    monkeypatch.setattr(assembly_module, "AsyncOpenAI", lambda **_kwargs: object())
    monkeypatch.setattr(qwen_module, "QwenAudioRealtimeAdapter", lambda **_kwargs: provider)
    initial = tmp_path / "initial"
    initial.mkdir()
    service_ids = count(1)
    realtime = build_qwen_realtime_assembly(
        Settings(
            model_api_key=SecretStr("model-secret"),
            dashscope_api_key=SecretStr("realtime-secret"),
            tavily_api_key=SecretStr("search-secret"),
            executor="codex",
            codex_workspace=initial,
            codex_managed_root=managed_root,
            codex_project_state_root=tmp_path / "unused-state",
            codex_prewarm=False,
            _env_file=None,
        ),
        sink=_Sink(),
        on_audio_frame=lambda _frame: None,
        on_audio_clear=lambda _utterance_id, _epoch: None,
        on_audio_terminal=lambda _utterance_id, _epoch: None,
        on_delivery=lambda _completion: None,
        id_factory=lambda: f"e2e-{next(service_ids)}",
    )
    await realtime.start()
    proposal = await adapter.dispatch(
        "project",
        {
            "action": "create_workspace",
            "workspace": "tetris",
            "session": "Initial build",
            "work_order": "build the tetris game",
        },
        SimpleNamespace(
            clock=clock,
            progress=None,
            delegate=SimpleNamespace(
                origin_ref="conversation:request",
                delegate_id="delegate-proposal",
                private=None,
            ),
        ),
    )
    proposal_id = proposal.content["proposal_id"]
    assert isinstance(proposal_id, str)
    await realtime.service.handle_event(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-confirm",
            provider_item_id="user-confirm",
        )
    )
    await realtime.service.handle_event(
        UserSpeechEnded(
            session_epoch=1,
            speech_id="speech-confirm",
        )
    )
    await realtime.service.handle_event(
        ResponseStarted(
            session_epoch=1,
            response_id="response-confirm",
        )
    )
    await realtime.service.handle_event(
        UserTranscriptFinal(
            session_epoch=1,
            item_id="user-confirm",
            text="好，创建吧",
        )
    )
    return _CreateHarness(
        realtime=realtime,
        store=store,
        confirmation=confirmation,
        adapter=adapter,
        provider=provider,
        proposal_id=proposal_id,
        worker_calls=worker_calls,
        work_orders=work_orders,
    )


def _confirmation_outputs(provider: _Provider, call_id: str) -> list[dict[str, object]]:
    return [
        json.loads(item.content)
        for item in provider.injected
        if item.kind == "tool_output" and item.call_id == call_id
    ]


async def _wait_until(predicate: Callable[[], bool]) -> None:
    async with asyncio.timeout(2.0):
        while True:
            try:
                if predicate():
                    return
            except ProjectStateError as failure:
                if failure.code != "state_busy":
                    raise
            await asyncio.sleep(0.01)


def test_ready_session_and_active_workspace_survive_registry_restart(tmp_path: Path) -> None:
    clock = VirtualClock(start=10.0)
    first = _store(tmp_path, ["workspace-alpha", "session-task-one"], clock)
    workspace = first.create_managed("alpha")
    session = first.begin_session(workspace.workspace_id, "Task 1")
    first.mark_session_ready(session.session_id, "thread-persistent")

    restarted = _store(tmp_path, ["unused-identifier"], clock)
    restored_workspace = restarted.resolve_workspace(None)
    restored_session = restarted.resolve_session(restored_workspace.workspace_id, "Task 1")

    assert restored_workspace.display_name == "alpha"
    assert restored_session.codex_thread_id == "thread-persistent"
    assert restored_session.state == "ready"


def test_proposal_has_zero_mutation_and_public_projection_has_no_private_values(
    tmp_path: Path,
) -> None:
    clock = VirtualClock(start=10.0)
    store = _store(tmp_path, ["workspace-alpha"], clock)
    workspace = store.create_managed("alpha")
    before = store.snapshot()
    controller = ProjectConfirmationController(clock=clock, id_factory=lambda: "private-nonce")

    proposal = controller.prepare(
        action="select",
        workspace_display_name="alpha",
        workspace_id=workspace.workspace_id,
        session_title=None,
        session_id=None,
        work_order=None,
        origin_ref="conversation:1",
    )

    assert proposal.proposal_id == "private-nonce"
    assert proposal.expires_at == 100.0
    assert store.snapshot() == before
    public = codex_project_message(store.public_view(pending_confirmation=True))
    assert json.loads(public) == {
        "type": "codex.project",
        "workspace_display_name": "alpha",
        "session_title": None,
        "pending_confirmation": True,
        "pending_action": None,
        "pending_workspace_display_name": None,
        "pending_session_title": None,
        "pending_expires_in_seconds": None,
    }
    for private in (
        workspace.workspace_id,
        workspace.canonical_path,
        workspace.codex_home_key,
        "private-nonce",
    ):
        assert private not in public


def test_workspace_cannot_resolve_another_workspaces_session(tmp_path: Path) -> None:
    clock = VirtualClock(start=10.0)
    store = _store(
        tmp_path,
        ["workspace-alpha", "session-alpha", "workspace-beta"],
        clock,
    )
    alpha = store.create_managed("alpha")
    session = store.begin_session(alpha.workspace_id, "Task 1")
    store.mark_session_ready(session.session_id, "thread-alpha")
    beta = store.create_managed("beta")

    try:
        store.activate_session(beta.workspace_id, session.session_id)
    except ProjectStateError as failure:
        assert failure.code == "session_workspace_mismatch"
    else:  # pragma: no cover - safety assertion
        raise AssertionError("cross-workspace Session activation was accepted")


@pytest.mark.asyncio
async def test_independent_create_uses_structured_confirmation_and_starts_managed_work(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    clock = VirtualClock(start=10.0)
    managed_root = tmp_path / "managed"
    store = _store(tmp_path, ["workspace-tetris", "session-tetris"], clock)
    confirmation = ProjectConfirmationController(
        clock=clock,
        id_factory=lambda: "proposal-create-tetris",
    )
    work_orders: list[str] = []
    adapter = ProjectCodexAdapter(
        store=store,
        confirmation=confirmation,
        worker_factory=lambda _workspace, _home, _resume, on_ready: _Worker(on_ready, work_orders),
    )
    provider = _Provider()
    monkeypatch.setitem(assembly_module._EXECUTOR_FACTORIES, "codex", lambda _context: adapter)
    monkeypatch.setattr(assembly_module, "AsyncOpenAI", lambda **_kwargs: object())
    monkeypatch.setattr(qwen_module, "QwenAudioRealtimeAdapter", lambda **_kwargs: provider)
    initial = tmp_path / "initial"
    initial.mkdir()
    service_ids = count(1)
    realtime = build_qwen_realtime_assembly(
        Settings(
            model_api_key=SecretStr("model-secret"),
            dashscope_api_key=SecretStr("realtime-secret"),
            tavily_api_key=SecretStr("search-secret"),
            executor="codex",
            codex_workspace=initial,
            codex_managed_root=managed_root,
            codex_project_state_root=tmp_path / "unused-state",
            codex_prewarm=False,
            _env_file=None,
        ),
        sink=_Sink(),
        on_audio_frame=lambda _frame: None,
        on_audio_clear=lambda _utterance_id, _epoch: None,
        on_audio_terminal=lambda _utterance_id, _epoch: None,
        on_delivery=lambda _completion: None,
        id_factory=lambda: f"e2e-{next(service_ids)}",
    )

    await realtime.start()
    try:
        proposal = await adapter.dispatch(
            "project",
            {
                "action": "create_workspace",
                "workspace": "tetris",
                "work_order": "build the tetris game",
            },
            SimpleNamespace(
                clock=clock,
                progress=None,
                delegate=SimpleNamespace(
                    origin_ref="conversation:request",
                    delegate_id="delegate-proposal",
                    private=None,
                ),
            ),
        )
        assert proposal.content["code"] == "confirmation_required"
        assert store.snapshot().workspaces == ()

        await realtime.service.handle_event(
            UserSpeechStarted(
                session_epoch=1,
                speech_id="speech-confirm",
                provider_item_id="user-confirm",
            )
        )
        await realtime.service.handle_event(
            UserSpeechEnded(
                session_epoch=1,
                speech_id="speech-confirm",
            )
        )
        await realtime.service.handle_event(
            ResponseStarted(
                session_epoch=1,
                response_id="response-confirm",
            )
        )
        await realtime.service.handle_event(
            UserTranscriptFinal(
                session_epoch=1,
                item_id="user-confirm",
                text="好，创建吧",
            )
        )
        confirmation_call = ToolCallReady(
            session_epoch=1,
            response_id="response-confirm",
            call_id="confirm-create",
            item_id="function-create",
            name="codex__confirm_project_action",
            arguments={
                "proposal_id": proposal.content["proposal_id"],
                "confirmed": True,
            },
        )
        await realtime.service.handle_event(confirmation_call)
        confirmation_outputs = [
            json.loads(item.content)
            for item in provider.injected
            if item.kind == "tool_output" and item.call_id == "confirm-create"
        ]
        assert confirmation_outputs == [{"code": "confirmed", "state": "accepted"}]
        await _wait_until(lambda: len(store.snapshot().sessions) == 1)

        snapshot = store.snapshot()
        created = next(item for item in snapshot.workspaces if item.display_name == "tetris")
        assert created.origin == "managed"
        assert Path(created.canonical_path).parent == managed_root.resolve()
        assert snapshot.active_workspace_id == created.workspace_id
        session = next(
            item for item in snapshot.sessions if item.workspace_id == created.workspace_id
        )
        assert session.display_title == "任务 1"
        assert session.codex_thread_id == "thread-tetris"
        assert work_orders == ["build the tetris game"]
        await _wait_until(lambda: len(provider.workspace_contexts) == 1)
        first_context = provider.workspace_contexts[0]
        assert first_context.item.session_epoch == 1
        assert first_context.item.workspace_instance_id == created.workspace_id
        assert first_context.item.content == (
            '<active_project_context>\nworkspace="tetris"\nsession="任务 1"\n'
            "</active_project_context>"
        )

        await realtime.service.session.reconnect(tools=tuple(realtime.tools.schemas))
        epoch_two = [
            record for record in provider.workspace_contexts if record.item.session_epoch == 2
        ]
        assert len(epoch_two) == 1
        assert epoch_two[0].item.revision > first_context.item.revision
        assert "Initial build" not in epoch_two[0].item.content

        before_replay = store.snapshot()
        await realtime.service.handle_event(
            ToolCallReady(
                session_epoch=1,
                response_id="response-confirm",
                call_id="confirm-replay",
                item_id="function-replay",
                name="codex__confirm_project_action",
                arguments={
                    "proposal_id": proposal.content["proposal_id"],
                    "confirmed": True,
                },
            )
        )
        assert store.snapshot() == before_replay
        assert work_orders == ["build the tetris game"]
    finally:
        await realtime.stop()


@pytest.mark.parametrize(
    ("proposal_id_override", "confirmed", "output_code", "expected_pending"),
    [
        (None, False, "cancelled", False),
        ("proposal-wrong", True, "invalid", True),
        (None, "true", "confirmation_invalid", True),
    ],
)
@pytest.mark.asyncio
async def test_rejected_wrong_id_and_non_boolean_service_decisions_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    proposal_id_override: str | None,
    confirmed: object,
    output_code: str,
    expected_pending: bool,
) -> None:
    harness = await _create_harness(monkeypatch, tmp_path)
    try:
        before = harness.store.snapshot()
        await harness.realtime.service.handle_event(
            ToolCallReady(
                session_epoch=1,
                response_id="response-confirm",
                call_id="confirm-invalid",
                item_id="function-invalid",
                name="codex__confirm_project_action",
                arguments={
                    "proposal_id": (
                        harness.proposal_id
                        if proposal_id_override is None
                        else proposal_id_override
                    ),
                    "confirmed": confirmed,
                },  # type: ignore[arg-type]
            )
        )

        assert _confirmation_outputs(harness.provider, "confirm-invalid") == [
            {"code": output_code, "state": "refused"}
        ]
        assert harness.store.snapshot() == before
        assert harness.confirmation.pending is expected_pending
        assert harness.adapter.commit_calls == 0
        assert harness.worker_calls == []
        assert harness.work_orders == []

        followup_call_id = "confirm-valid" if expected_pending else "confirm-after-cancel"
        await harness.realtime.service.handle_event(
            ToolCallReady(
                session_epoch=1,
                response_id="response-confirm",
                call_id=followup_call_id,
                item_id=f"function-{followup_call_id}",
                name="codex__confirm_project_action",
                arguments={"proposal_id": harness.proposal_id, "confirmed": True},
            )
        )
        if not expected_pending:
            assert _confirmation_outputs(harness.provider, followup_call_id) == [
                {"code": "confirmation_not_pending", "state": "refused"}
            ]
            assert harness.store.snapshot() == before
            assert harness.adapter.commit_calls == 0
            assert harness.worker_calls == []
            assert harness.work_orders == []
            return

        assert _confirmation_outputs(harness.provider, followup_call_id) == [
            {"code": "confirmed", "state": "accepted"}
        ]
        await _wait_until(lambda: len(harness.store.snapshot().sessions) == 1)
        committed = harness.store.snapshot()
        assert len(committed.workspaces) == 1
        assert committed.active_workspace_id == committed.workspaces[0].workspace_id
        assert harness.adapter.commit_calls == 1
        assert harness.worker_calls == ["created"]
        assert harness.work_orders == ["build the tetris game"]

        await harness.realtime.service.handle_event(
            ToolCallReady(
                session_epoch=1,
                response_id="response-confirm",
                call_id="confirm-replay",
                item_id="function-replay",
                name="codex__confirm_project_action",
                arguments={"proposal_id": harness.proposal_id, "confirmed": True},
            )
        )
        assert _confirmation_outputs(harness.provider, "confirm-replay") == [
            {"code": "confirmation_not_pending", "state": "refused"}
        ]
        assert harness.store.snapshot() == committed
        assert harness.adapter.commit_calls == 1
        assert harness.worker_calls == ["created"]
        assert harness.work_orders == ["build the tetris game"]
    finally:
        await harness.realtime.stop()
