from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Mapping
from itertools import count
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from pydantic import SecretStr
import pytest

import nova_audio_agent.assembly as assembly_module
import nova_audio_agent.realtime.qwen as qwen_module
from nova_audio_agent.assembly import build_qwen_realtime_assembly
from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.config import Settings
from nova_audio_agent.executors.codex import CodexProcessStatus, CodexTransportResult
from nova_audio_agent.executors.codex_app_server import SteerTransportResult
from nova_audio_agent.executors.codex_project_live import ProjectCodexAdapter
from nova_audio_agent.executors.codex_projects import CodexProjectStore, ProjectStateError
from nova_audio_agent.realtime.desktop import codex_project_message
from nova_audio_agent.realtime.project_confirmation import ProjectConfirmationController
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

    async def create_response(self, intent: HostResponseIntent) -> None:
        del intent

    async def cancel_response(self, response_id: str) -> None:
        del response_id

    async def close(self) -> None:
        return None

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

    assert proposal.nonce == "private-nonce"
    assert proposal.expires_at == 100.0
    assert store.snapshot() == before
    public = codex_project_message(store.public_view(pending_confirmation=True))
    assert json.loads(public) == {
        "type": "codex.project",
        "workspace_display_name": "alpha",
        "session_title": None,
        "pending_confirmation": True,
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
        worker_factory=lambda _workspace, _home, _resume, on_ready: _Worker(
            on_ready, work_orders
        ),
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
        assert proposal.content["code"] == "confirmation_required"
        assert store.snapshot().workspaces == ()

        await realtime.service.handle_event(UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-confirm",
            provider_item_id="user-confirm",
        ))
        await realtime.service.handle_event(UserSpeechEnded(
            session_epoch=1,
            speech_id="speech-confirm",
        ))
        await realtime.service.handle_event(ResponseStarted(
            session_epoch=1,
            response_id="response-confirm",
        ))
        await realtime.service.handle_event(UserTranscriptFinal(
            session_epoch=1,
            item_id="user-confirm",
            text="好，创建吧",
        ))
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
        session = next(item for item in snapshot.sessions if item.workspace_id == created.workspace_id)
        assert session.display_title == "Initial build"
        assert session.codex_thread_id == "thread-tetris"
        assert work_orders == ["build the tetris game"]

        before_replay = store.snapshot()
        await realtime.service.handle_event(ToolCallReady(
            session_epoch=1,
            response_id="response-confirm",
            call_id="confirm-replay",
            item_id="function-replay",
            name="codex__confirm_project_action",
            arguments={
                "proposal_id": proposal.content["proposal_id"],
                "confirmed": True,
            },
        ))
        assert store.snapshot() == before_replay
        assert work_orders == ["build the tetris game"]
    finally:
        await realtime.stop()


@pytest.mark.parametrize(
    ("proposal_id", "confirmed", "expected_kind", "expected_pending"),
    [
        ("proposal-create", False, "cancelled", False),
        ("proposal-wrong", True, "invalid", True),
        ("proposal-create", "true", "invalid", True),
    ],
)
def test_rejected_wrong_id_and_non_boolean_decisions_have_zero_side_effects(
    tmp_path: Path,
    proposal_id: str,
    confirmed: object,
    expected_kind: str,
    expected_pending: bool,
) -> None:
    clock = VirtualClock(start=10.0)
    store = _store(tmp_path, ["unused-workspace"], clock)
    controller = ProjectConfirmationController(clock=clock, id_factory=lambda: "proposal-create")
    controller.prepare(
        action="create",
        workspace_display_name="tetris",
        workspace_id=None,
        session_title=None,
        session_id=None,
        work_order="build",
        origin_ref="conversation:1",
    )
    assert controller.reserve_user_item(epoch=1, item_id="user-confirm")
    outcome = controller.accept_decision(
        epoch=1,
        item_id="user-confirm",
        proposal_id=proposal_id,
        confirmed=confirmed,  # type: ignore[arg-type]
    )

    assert outcome.kind == expected_kind
    assert outcome.operation is None
    assert controller.pending is expected_pending
    assert store.snapshot().workspaces == ()
