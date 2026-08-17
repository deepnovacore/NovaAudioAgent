from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from nova_audio_agent.executors.codex_projects import (
    CodexProjectStore,
    ProjectStateError,
)


class _Ids:
    def __init__(self) -> None:
        self._value = 0

    def __call__(self) -> str:
        self._value += 1
        return f"id{self._value:030x}"


class _Now:
    def __init__(self) -> None:
        self.value = 100.0

    def __call__(self) -> float:
        self.value += 1.0
        return self.value


def _store(tmp_path: Path, *, ids: _Ids | None = None) -> CodexProjectStore:
    return CodexProjectStore(
        tmp_path / "state",
        tmp_path / "managed",
        now=_Now(),
        id_factory=ids or _Ids(),
    )


def _workspace(tmp_path: Path, name: str) -> Path:
    path = tmp_path / name
    path.mkdir()
    return path


def test_first_enable_imports_configured_workspace_once_and_restores_active_state(
    tmp_path: Path,
) -> None:
    workspace = _workspace(tmp_path, "existing")
    store = _store(tmp_path)

    first = store.ensure_imported("existing", workspace)
    second = store.ensure_imported("existing", workspace)

    assert first.workspace_id == second.workspace_id
    assert store.snapshot().active_workspace_id == first.workspace_id
    payload = json.loads((tmp_path / "state" / "codex-projects-v1.json").read_text())
    assert payload["version"] == 1
    assert len(payload["workspaces"]) == 1


def test_two_store_instances_reload_under_lock_instead_of_losing_updates(tmp_path: Path) -> None:
    ids = _Ids()
    first = _store(tmp_path, ids=ids)
    second = _store(tmp_path, ids=ids)
    first.ensure_imported("one", _workspace(tmp_path, "one"))

    second.register_workspace("two", _workspace(tmp_path, "two"))

    assert [item.display_name for item in first.list_workspaces()] == ["one", "two"]


def test_registry_and_lock_permissions_are_owner_only(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.ensure_imported("one", _workspace(tmp_path, "one"))

    state_root = tmp_path / "state"
    assert state_root.stat().st_mode & 0o777 == 0o700
    assert (state_root / "codex-projects-v1.json").stat().st_mode & 0o777 == 0o600
    assert (state_root / "codex-projects-v1.lock").stat().st_mode & 0o777 == 0o600


def test_corrupt_registry_is_preserved_and_fails_closed(tmp_path: Path) -> None:
    state_root = tmp_path / "state"
    state_root.mkdir(mode=0o700)
    path = state_root / "codex-projects-v1.json"
    raw = b'{"version":1,"workspaces":'
    path.write_bytes(raw)
    path.chmod(0o600)

    with pytest.raises(ProjectStateError, match="state_corrupt") as raised:
        _store(tmp_path).snapshot()

    assert path.read_bytes() == raw
    assert str(tmp_path) not in repr(raised.value)


def test_unsafe_existing_registry_mode_fails_closed(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.ensure_imported("one", _workspace(tmp_path, "one"))
    path = tmp_path / "state" / "codex-projects-v1.json"
    path.chmod(0o644)

    with pytest.raises(ProjectStateError, match="state_permissions"):
        store.snapshot()


@pytest.mark.parametrize(
    "name",
    ["", "../escape", "a/b", "a\\b", "file://x", "C:\\x", "\x00"],
)
def test_managed_creation_rejects_path_like_voice_names(tmp_path: Path, name: str) -> None:
    with pytest.raises(ProjectStateError, match="workspace_name_invalid"):
        _store(tmp_path).create_managed(name)


def test_managed_creation_uses_one_real_direct_child_and_distinct_home_key(
    tmp_path: Path,
) -> None:
    store = _store(tmp_path)

    workspace = store.create_managed("天气 看板")
    path = Path(workspace.canonical_path)

    assert path.parent == (tmp_path / "managed").resolve()
    assert path.is_dir()
    assert not path.is_symlink()
    assert path.stat().st_mode & 0o777 == 0o700
    assert workspace.display_name == "天气 看板"
    assert workspace.codex_home_key.startswith("home-")


def test_managed_name_collision_uses_nfkc_casefold_exact_key(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.create_managed("Ａlpha")

    with pytest.raises(ProjectStateError, match="workspace_name_conflict"):
        store.create_managed("alpha")


def test_managed_root_symlink_is_refused(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    (tmp_path / "managed").symlink_to(target, target_is_directory=True)

    with pytest.raises(ProjectStateError, match="managed_root_unsafe"):
        _store(tmp_path).create_managed("alpha")


def test_rollback_removes_only_an_empty_new_managed_workspace(tmp_path: Path) -> None:
    store = _store(tmp_path)
    empty = store.create_managed("empty")
    empty_path = Path(empty.canonical_path)
    assert store.rollback_managed_create(empty.workspace_id) is True
    assert not empty_path.exists()

    retained = store.create_managed("retained")
    retained_path = Path(retained.canonical_path)
    retained_path.joinpath("keep.txt").write_text("user data")
    assert store.rollback_managed_create(retained.workspace_id) is False
    assert retained_path.exists()
    assert store.resolve_workspace("retained").workspace_id == retained.workspace_id


def test_registered_workspace_is_revalidated_and_symlink_replacement_is_refused(
    tmp_path: Path,
) -> None:
    original = _workspace(tmp_path, "original")
    other = _workspace(tmp_path, "other")
    store = _store(tmp_path)
    record = store.register_workspace("alpha", original)
    original.rmdir()
    original.symlink_to(other, target_is_directory=True)

    with pytest.raises(ProjectStateError, match="workspace_boundary_changed"):
        store.revalidate_workspace(record.workspace_id)


def test_sessions_transition_starting_ready_and_recover_incomplete_start(tmp_path: Path) -> None:
    store = _store(tmp_path)
    workspace = store.ensure_imported("alpha", _workspace(tmp_path, "alpha"))
    first = store.begin_session(workspace.workspace_id, "登录修复")
    assert first.state == "starting"
    assert first.codex_thread_id is None

    ready = store.mark_session_ready(first.session_id, "thread-a")
    assert ready.state == "ready"
    assert ready.codex_thread_id == "thread-a"
    assert store.resolve_session(workspace.workspace_id, "登录修复") == ready

    second = store.begin_session(workspace.workspace_id, None)
    restarted = _store(tmp_path)
    recovered = restarted.resolve_session(workspace.workspace_id, second.display_title)
    assert recovered.state == "unavailable"
    assert recovered.codex_thread_id is None


def test_sessions_are_workspace_scoped_and_titles_receive_deterministic_suffix(
    tmp_path: Path,
) -> None:
    store = _store(tmp_path)
    alpha = store.ensure_imported("alpha", _workspace(tmp_path, "alpha"))
    beta = store.register_workspace("beta", _workspace(tmp_path, "beta"))
    first = store.begin_session(alpha.workspace_id, "Task")
    second = store.begin_session(alpha.workspace_id, "task")

    assert first.display_title == "Task"
    assert second.display_title == "task (2)"
    with pytest.raises(ProjectStateError, match="session_not_found"):
        store.resolve_session(beta.workspace_id, first.display_title)


def test_select_and_activate_session_persist_across_store_instances(tmp_path: Path) -> None:
    ids = _Ids()
    store = _store(tmp_path, ids=ids)
    alpha = store.ensure_imported("alpha", _workspace(tmp_path, "alpha"))
    beta = store.register_workspace("beta", _workspace(tmp_path, "beta"))
    session = store.begin_session(beta.workspace_id, "Task 1")
    store.mark_session_ready(session.session_id, "thread-beta")
    store.select_workspace("beta")
    store.activate_session(beta.workspace_id, session.session_id)

    restarted = _store(tmp_path, ids=ids)
    snapshot = restarted.snapshot()
    assert snapshot.active_workspace_id == beta.workspace_id
    assert restarted.resolve_workspace(None).workspace_id == beta.workspace_id
    assert restarted.resolve_session(beta.workspace_id, None).session_id == session.session_id
    assert restarted.resolve_workspace("alpha").workspace_id == alpha.workspace_id


def test_private_values_are_not_in_public_view_or_errors(tmp_path: Path) -> None:
    store = _store(tmp_path)
    record = store.ensure_imported("alpha", _workspace(tmp_path, "secret-path"))
    view = store.public_view(pending_confirmation=True)

    assert view.workspace_display_name == "alpha"
    assert view.session_title is None
    assert view.pending_confirmation is True
    rendered = repr(view)
    assert record.workspace_id not in rendered
    assert record.canonical_path not in rendered
    assert record.codex_home_key not in rendered


def test_managed_root_must_not_be_group_or_world_writable(tmp_path: Path) -> None:
    managed = tmp_path / "managed"
    managed.mkdir(mode=0o777)
    managed.chmod(0o777)

    with pytest.raises(ProjectStateError, match="managed_root_unsafe"):
        _store(tmp_path).create_managed("alpha")


@pytest.mark.skipif(not hasattr(os, "getuid"), reason="POSIX ownership contract")
def test_registry_rejects_oversized_payload_before_json_decode(tmp_path: Path) -> None:
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    path = state / "codex-projects-v1.json"
    path.write_bytes(b" " * (1024 * 1024 + 1))
    path.chmod(0o600)

    with pytest.raises(ProjectStateError, match="state_too_large"):
        _store(tmp_path).snapshot()
