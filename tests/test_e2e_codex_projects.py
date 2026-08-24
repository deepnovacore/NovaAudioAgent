from __future__ import annotations

import json
from pathlib import Path

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.executors.codex_projects import CodexProjectStore, ProjectStateError
from nova_audio_agent.realtime.desktop import codex_project_message
from nova_audio_agent.realtime.project_confirmation import ProjectConfirmationController


def _store(tmp_path: Path, ids: list[str], clock: VirtualClock) -> CodexProjectStore:
    values = iter(ids)
    return CodexProjectStore(
        tmp_path / "state",
        tmp_path / "managed",
        now=clock.now,
        id_factory=values.__next__,
    )


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
