from __future__ import annotations

import json
import fcntl
import os
import threading
from pathlib import Path

import pytest

import nova_audio_agent.executors.codex_projects as codex_projects
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


def _store(
    tmp_path: Path,
    *,
    ids: _Ids | None = None,
    recover_starting: bool = False,
) -> CodexProjectStore:
    return CodexProjectStore(
        tmp_path / "state",
        tmp_path / "managed",
        now=_Now(),
        id_factory=ids or _Ids(),
        recover_starting=recover_starting,
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
    snapshot = store.snapshot()
    assert snapshot.active_workspace_id == first.workspace_id
    assert snapshot.active_binding_revision > 0
    payload = json.loads((tmp_path / "state" / "codex-projects-v1.json").read_text())
    assert payload["version"] == 1
    assert payload["active_binding_revision"] == snapshot.active_binding_revision
    assert len(payload["workspaces"]) == 1


def test_legacy_exact_v1_gains_revision_on_next_active_binding_mutation(
    tmp_path: Path,
) -> None:
    state_root = tmp_path / "state"
    state_root.mkdir(mode=0o700)
    state_path = state_root / "codex-projects-v1.json"
    state_path.write_text('{"version":1,"active_workspace_id":null,"workspaces":{},"sessions":{}}')
    state_path.chmod(0o600)
    store = _store(tmp_path)

    assert store.snapshot().active_binding_revision == 0
    store.create_managed("migrated")

    migrated = json.loads(state_path.read_text())
    assert migrated["active_binding_revision"] == 1
    assert set(migrated) == {
        "version",
        "active_binding_revision",
        "active_workspace_id",
        "workspaces",
        "sessions",
    }


def test_new_configured_checkout_is_registered_without_replacing_active_workspace(
    tmp_path: Path,
) -> None:
    store = _store(tmp_path)
    first = store.ensure_imported("project", _workspace(tmp_path, "one"))

    second = store.ensure_imported("project", _workspace(tmp_path, "two"))
    repeated = store.ensure_imported("ignored", tmp_path / "two")

    assert second.workspace_id != first.workspace_id
    assert second.display_name == "project (2)"
    assert repeated.workspace_id == second.workspace_id
    assert store.snapshot().active_workspace_id == first.workspace_id


def test_workspace_limit_is_bounded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(codex_projects, "MAX_WORKSPACES", 2)
    store = _store(tmp_path)
    store.ensure_imported("one", _workspace(tmp_path, "one"))
    store.ensure_imported("two", _workspace(tmp_path, "two"))

    with pytest.raises(ProjectStateError, match="workspace_limit"):
        store.ensure_imported("three", _workspace(tmp_path, "three"))


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


@pytest.mark.skipif(not hasattr(os, "getuid"), reason="POSIX ownership contract")
def test_state_root_rejects_special_permission_bits(tmp_path: Path) -> None:
    state_root = tmp_path / "state"
    state_root.mkdir(mode=0o700)
    state_root.chmod(0o1700)

    with pytest.raises(ProjectStateError, match="state_permissions"):
        _store(tmp_path).snapshot()


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
    restarted = _store(tmp_path, recover_starting=True)
    recovered = restarted.resolve_session(workspace.workspace_id, second.display_title)
    assert recovered.state == "unavailable"
    assert recovered.codex_thread_id is None


def test_default_session_titles_are_speakable_workspace_ordinals(tmp_path: Path) -> None:
    store = _store(tmp_path)
    workspace = store.ensure_imported("alpha", _workspace(tmp_path, "alpha"))
    first = store.begin_session(workspace.workspace_id, None)
    store.mark_session_ready(first.session_id, "thread-one")
    second = store.begin_session(workspace.workspace_id, None)

    assert (first.display_title, second.display_title) == ("任务 1", "任务 2")


def test_default_session_titles_increment_arbitrary_precision_python_integers(
    tmp_path: Path,
) -> None:
    store = _store(tmp_path)
    workspace = store.ensure_imported("alpha", _workspace(tmp_path, "alpha"))
    store.begin_session(workspace.workspace_id, "任务 9007199254740993")

    generated = store.begin_session(workspace.workspace_id, None)

    assert generated.display_title == "任务 9007199254740994"


def test_session_retention_prunes_unavailable_before_inactive_ready(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _store(tmp_path)
    workspace = store.ensure_imported("alpha", _workspace(tmp_path, "alpha"))
    unavailable = store.begin_session(workspace.workspace_id, "unavailable")
    store.mark_session_unavailable(unavailable.session_id)
    inactive = store.begin_session(workspace.workspace_id, "inactive")
    store.mark_session_ready(inactive.session_id, "thread-inactive")
    active = store.begin_session(workspace.workspace_id, "active")
    store.mark_session_ready(active.session_id, "thread-active")
    monkeypatch.setattr(codex_projects, "MAX_SESSIONS_PER_WORKSPACE", 3)
    monkeypatch.setattr(codex_projects, "MAX_SESSIONS_TOTAL", 3)

    fourth = store.begin_session(workspace.workspace_id, "fourth")
    after_first_prune = {item.session_id for item in store.list_sessions(workspace)}
    assert unavailable.session_id not in after_first_prune
    assert inactive.session_id in after_first_prune
    assert active.session_id in after_first_prune
    store.mark_session_ready(fourth.session_id, "thread-fourth")

    fifth = store.begin_session(workspace.workspace_id, "fifth")
    after_second_prune = {item.session_id for item in store.list_sessions(workspace)}
    assert inactive.session_id not in after_second_prune
    assert active.session_id in after_second_prune
    assert fourth.session_id in after_second_prune
    assert fifth.session_id in after_second_prune


def test_session_retention_never_prunes_starting_or_active_records(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _store(tmp_path)
    workspace = store.ensure_imported("alpha", _workspace(tmp_path, "alpha"))
    starting = store.begin_session(workspace.workspace_id, "starting")
    active = store.begin_session(workspace.workspace_id, "active")
    store.mark_session_ready(active.session_id, "thread-active")
    monkeypatch.setattr(codex_projects, "MAX_SESSIONS_PER_WORKSPACE", 2)
    monkeypatch.setattr(codex_projects, "MAX_SESSIONS_TOTAL", 2)

    with pytest.raises(ProjectStateError, match="session_limit"):
        store.begin_session(workspace.workspace_id, "cannot-fit")

    retained = {item.session_id for item in store.list_sessions(workspace)}
    assert retained == {starting.session_id, active.session_id}


def test_rollback_session_start_repairs_active_session_and_is_state_safe(tmp_path: Path) -> None:
    store = _store(tmp_path)
    workspace = store.ensure_imported("alpha", _workspace(tmp_path, "alpha"))
    ready = store.begin_session(workspace.workspace_id, "ready")
    store.mark_session_ready(ready.session_id, "thread-ready")
    provisional = store.begin_session(workspace.workspace_id, "provisional")

    assert store.rollback_session_start(provisional.session_id) is True
    assert store.resolve_session(workspace.workspace_id, None).session_id == ready.session_id
    assert store.rollback_session_start(provisional.session_id) is False
    assert store.rollback_session_start(ready.session_id) is False


def test_contended_registry_returns_state_busy_without_blocking(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.ensure_imported("alpha", _workspace(tmp_path, "alpha"))
    lock_fd = os.open(store.lock_path, os.O_RDWR)
    fcntl.flock(lock_fd, fcntl.LOCK_EX)
    failures: list[BaseException] = []

    def read() -> None:
        try:
            store.snapshot()
        except BaseException as failure:
            failures.append(failure)

    thread = threading.Thread(target=read)
    thread.start()
    thread.join(0.1)
    returned_immediately = not thread.is_alive()
    fcntl.flock(lock_fd, fcntl.LOCK_UN)
    os.close(lock_fd)
    thread.join(1.0)

    assert returned_immediately is True
    assert len(failures) == 1
    assert isinstance(failures[0], ProjectStateError)
    assert failures[0].code == "state_busy"


def test_ordinary_second_store_does_not_recover_a_live_starting_session(tmp_path: Path) -> None:
    live = _store(tmp_path)
    workspace = live.ensure_imported("alpha", _workspace(tmp_path, "alpha"))
    starting = live.begin_session(workspace.workspace_id, "Task 1")

    cli_store = _store(tmp_path)
    observed = cli_store.resolve_session(workspace.workspace_id, "Task 1")
    ready = live.mark_session_ready(starting.session_id, "thread-live")

    assert observed.state == "starting"
    assert ready.state == "ready"


def test_second_live_owner_cannot_recover_first_owners_starting_session(
    tmp_path: Path,
) -> None:
    first = _store(tmp_path, recover_starting=True)
    workspace = first.ensure_imported("alpha", _workspace(tmp_path, "alpha"))
    starting = first.begin_session(workspace.workspace_id, "Task 1")

    with pytest.raises(ProjectStateError, match="state_busy"):
        _store(tmp_path, recover_starting=True)

    ready = first.mark_session_ready(starting.session_id, "thread-live")
    assert ready.state == "ready"


def test_next_live_owner_recovers_starting_after_prior_owner_closes(tmp_path: Path) -> None:
    first = _store(tmp_path, recover_starting=True)
    workspace = first.ensure_imported("alpha", _workspace(tmp_path, "alpha"))
    starting = first.begin_session(workspace.workspace_id, "Task 1")
    first.close()

    restarted = _store(tmp_path, recover_starting=True)
    observed = restarted.resolve_session(workspace.workspace_id, starting.display_title)

    assert observed.state == "unavailable"


def test_registry_decode_rejects_records_beyond_configured_caps(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _store(tmp_path)
    store.ensure_imported("alpha", _workspace(tmp_path, "alpha"))
    monkeypatch.setattr(codex_projects, "MAX_WORKSPACES", 0)

    with pytest.raises(ProjectStateError, match="state_corrupt"):
        _store(tmp_path).snapshot()


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="FIFO is POSIX-only")
def test_registry_rejects_non_regular_state_file_without_blocking(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.state_root.mkdir(mode=0o700)
    os.mkfifo(store.state_path, mode=0o600)

    with pytest.raises(ProjectStateError, match="state_permissions"):
        store.snapshot()


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


def test_managed_root_accepts_owner_controlled_group_read_execute(tmp_path: Path) -> None:
    managed = tmp_path / "managed"
    managed.mkdir(mode=0o750)
    managed.chmod(0o750)

    created = _store(tmp_path).create_managed("alpha")

    assert Path(created.canonical_path).parent == managed


@pytest.mark.skipif(not hasattr(os, "getuid"), reason="POSIX ownership contract")
def test_registry_rejects_oversized_payload_before_json_decode(tmp_path: Path) -> None:
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    path = state / "codex-projects-v1.json"
    path.write_bytes(b" " * (1024 * 1024 + 1))
    path.chmod(0o600)

    with pytest.raises(ProjectStateError, match="state_too_large"):
        _store(tmp_path).snapshot()


def test_maximally_retained_registry_encoding_stays_below_hard_byte_limit() -> None:
    workspaces: dict[str, codex_projects.WorkspaceRecord] = {}
    sessions: dict[str, codex_projects.ProjectSessionRecord] = {}
    for index in range(codex_projects.MAX_WORKSPACES):
        workspace_id = f"w{index:031d}"
        session_id = f"s{index:031d}"
        display_name = f"{index:03d}-" + "w" * (codex_projects.MAX_WORKSPACE_NAME - 4)
        workspaces[workspace_id] = codex_projects.WorkspaceRecord(
            workspace_id=workspace_id,
            display_name=display_name,
            normalized_name=display_name,
            canonical_path="/" + "p" * 1023,
            origin="registered",
            codex_home_key=f"home-{workspace_id}",
            active_session_id=session_id,
            created_at=float(index),
            last_used_at=float(index),
        )
    for index in range(codex_projects.MAX_SESSIONS_TOTAL):
        workspace_id = f"w{index % codex_projects.MAX_WORKSPACES:031d}"
        session_id = f"s{index:031d}"
        display_title = f"{index:04d}-" + "t" * (codex_projects.MAX_SESSION_TITLE - 5)
        sessions[session_id] = codex_projects.ProjectSessionRecord(
            session_id=session_id,
            workspace_id=workspace_id,
            display_title=display_title,
            normalized_title=display_title,
            codex_thread_id="x" * 256,
            state="ready",
            created_at=float(index),
            last_used_at=float(index),
        )
    state = codex_projects._State(
        active_workspace_id="w0000000000000000000000000000000",
        workspaces=workspaces,
        sessions=sessions,
    )

    raw = json.dumps(
        codex_projects._encode_state(state),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")

    assert len(raw) < codex_projects.MAX_STATE_BYTES


def test_marking_active_session_unavailable_promotes_newest_ready_session(
    tmp_path: Path,
) -> None:
    store = _store(tmp_path)
    workspace = store.create_managed("alpha")
    older = store.begin_session(workspace.workspace_id, "older")
    store.mark_session_ready(older.session_id, "thread-older")
    newer = store.begin_session(workspace.workspace_id, "newer")
    store.mark_session_ready(newer.session_id, "thread-newer")

    store.mark_session_unavailable(newer.session_id)
    assert store.resolve_session(workspace.workspace_id, None).session_id == older.session_id

    store.mark_session_unavailable(older.session_id)
    with pytest.raises(ProjectStateError, match="session_not_found"):
        store.resolve_session(workspace.workspace_id, None)


def test_rolled_back_managed_create_restores_most_recent_active_workspace(
    tmp_path: Path,
) -> None:
    store = _store(tmp_path)
    first = store.create_managed("first")
    store.create_managed("second")
    store.select_workspace("first")
    created = store.create_managed("third")
    assert store.snapshot().active_workspace_id == created.workspace_id

    assert store.rollback_managed_create(created.workspace_id, wait=True) is True

    snapshot = store.snapshot()
    assert snapshot.active_workspace_id == first.workspace_id
    assert [item.display_name for item in snapshot.workspaces] == ["first", "second"]
    assert not Path(created.canonical_path).exists()


def test_missing_fcntl_fails_closed_without_breaking_import(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _store(tmp_path)
    store.create_managed("alpha")
    monkeypatch.setattr(codex_projects, "fcntl", None)

    with pytest.raises(ProjectStateError, match="state_lock_failed"):
        store.snapshot()
    with pytest.raises(ProjectStateError, match="state_lock_failed"):
        _store(tmp_path, recover_starting=True)
