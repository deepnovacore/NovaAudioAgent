"""Host-owned Codex workspace and persistent Session registry."""

from __future__ import annotations

import errno
import json
import math
import os
import re
import stat
import unicodedata

try:
    import fcntl
except ImportError:  # pragma: no cover - non-POSIX platforms
    # The projects feature requires POSIX advisory locks, but merely importing
    # this module (e.g. via the executors package with projects disabled) must
    # not fail on platforms without fcntl; lock acquisition fails closed below.
    fcntl = None  # type: ignore[assignment]
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Literal, TypeVar
from uuid import uuid4

from nova_audio_agent.clock import RealClock

STATE_VERSION = 1
STATE_FILE = "codex-projects-v1.json"
LOCK_FILE = "codex-projects-v1.lock"
OWNER_LOCK_FILE = "codex-projects-v1.owner.lock"
MAX_STATE_BYTES = 1024 * 1024
MAX_WORKSPACE_NAME = 80
MAX_SESSION_TITLE = 120
MAX_WORKSPACES = 100
MAX_SESSIONS_PER_WORKSPACE = 200
MAX_SESSIONS_TOTAL = 1000
_ID = re.compile(r"[A-Za-z0-9_-]{8,80}\Z")
_DRIVE = re.compile(r"[A-Za-z]:")
_DEFAULT_SESSION_TITLE = re.compile(r"任务 ([1-9][0-9]*)\Z")
_T = TypeVar("_T")


class ProjectStateError(RuntimeError):
    """A bounded registry error whose text never includes private state."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class WorkspaceRecord:
    workspace_id: str
    display_name: str
    normalized_name: str
    canonical_path: str
    origin: Literal["managed", "registered"]
    codex_home_key: str
    active_session_id: str | None
    created_at: float
    last_used_at: float


@dataclass(frozen=True, slots=True)
class ProjectSessionRecord:
    session_id: str
    workspace_id: str
    display_title: str
    normalized_title: str
    codex_thread_id: str | None
    state: Literal["starting", "ready", "unavailable"]
    created_at: float
    last_used_at: float


@dataclass(frozen=True, slots=True)
class ProjectSnapshot:
    version: int
    active_workspace_id: str | None
    workspaces: tuple[WorkspaceRecord, ...]
    sessions: tuple[ProjectSessionRecord, ...]


@dataclass(frozen=True, slots=True)
class PublicProjectView:
    workspace_display_name: str | None
    session_title: str | None
    pending_confirmation: bool


@dataclass(slots=True)
class _State:
    active_workspace_id: str | None
    workspaces: dict[str, WorkspaceRecord]
    sessions: dict[str, ProjectSessionRecord]


class CodexProjectStore:
    """Serialize every project metadata update through one owner-only file lock."""

    def __init__(
        self,
        state_root: Path,
        managed_root: Path,
        *,
        now: Callable[[], float] | None = None,
        id_factory: Callable[[], str] | None = None,
        recover_starting: bool = False,
    ) -> None:
        self.state_root = state_root.expanduser().absolute()
        self.managed_root = managed_root.expanduser().absolute()
        self._now = RealClock().now if now is None else now
        self._id_factory = (lambda: uuid4().hex) if id_factory is None else id_factory
        self._recover_starting = recover_starting
        self._startup_loaded = False
        self._owner_fd: int | None = None
        if recover_starting:
            self._ensure_state_root()
            self._owner_fd = self._open_owner_lock()

    @property
    def state_path(self) -> Path:
        return self.state_root / STATE_FILE

    @property
    def lock_path(self) -> Path:
        return self.state_root / LOCK_FILE

    @property
    def owner_lock_path(self) -> Path:
        return self.state_root / OWNER_LOCK_FILE

    def close(self) -> None:
        fd, self._owner_fd = self._owner_fd, None
        if fd is None:
            return
        try:
            if fcntl is not None:
                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    def codex_home(self, workspace: WorkspaceRecord | str) -> Path:
        record = self._workspace_by_id(workspace) if isinstance(workspace, str) else workspace
        return self.state_root / "codex-workspaces" / record.codex_home_key

    def ensure_imported(self, display_name: str, path: Path) -> WorkspaceRecord:
        name, key = _workspace_name(display_name)
        canonical = _registered_path(path)

        def update(state: _State) -> tuple[WorkspaceRecord, bool]:
            for record in state.workspaces.values():
                if record.canonical_path == str(canonical):
                    if state.active_workspace_id is None:
                        state.active_workspace_id = record.workspace_id
                        return record, True
                    return record, False
            self._require_workspace_capacity(state)
            unique_name = self._unique_workspace_name(state, name)
            _display, unique_key = _workspace_name(unique_name)
            record = self._new_workspace(
                display_name=unique_name,
                normalized_name=unique_key,
                path=canonical,
                origin="registered",
            )
            state.workspaces[record.workspace_id] = record
            if state.active_workspace_id is None:
                state.active_workspace_id = record.workspace_id
            return record, True

        return self._transaction(update)

    def snapshot(self) -> ProjectSnapshot:
        def read(state: _State) -> tuple[ProjectSnapshot, bool]:
            return _snapshot(state), False

        return self._transaction(read)

    def list_workspaces(self) -> tuple[WorkspaceRecord, ...]:
        return self.snapshot().workspaces

    def list_sessions(self, workspace: str | WorkspaceRecord) -> tuple[ProjectSessionRecord, ...]:
        record = self._workspace_by_id(workspace) if isinstance(workspace, str) else workspace
        return tuple(
            session
            for session in self.snapshot().sessions
            if session.workspace_id == record.workspace_id
        )

    def resolve_workspace(self, display_name: str | None) -> WorkspaceRecord:
        if display_name is None:
            snapshot = self.snapshot()
            if snapshot.active_workspace_id is None:
                raise ProjectStateError("workspace_not_found")
            return next(
                item
                for item in snapshot.workspaces
                if item.workspace_id == snapshot.active_workspace_id
            )
        _name, key = _workspace_name(display_name)
        matches = [item for item in self.snapshot().workspaces if item.normalized_name == key]
        if len(matches) != 1:
            raise ProjectStateError("workspace_not_found")
        return matches[0]

    def resolve_session(
        self,
        workspace_id: str,
        display_title: str | None,
    ) -> ProjectSessionRecord:
        snapshot = self.snapshot()
        workspace = next(
            (item for item in snapshot.workspaces if item.workspace_id == workspace_id),
            None,
        )
        if workspace is None:
            raise ProjectStateError("workspace_not_found")
        if display_title is None:
            session_id = workspace.active_session_id
            if session_id is None:
                raise ProjectStateError("session_not_found")
            match = next(
                (item for item in snapshot.sessions if item.session_id == session_id),
                None,
            )
        else:
            _title, key = _session_title(display_title)
            match = next(
                (
                    item
                    for item in snapshot.sessions
                    if item.workspace_id == workspace_id and item.normalized_title == key
                ),
                None,
            )
        if match is None:
            raise ProjectStateError("session_not_found")
        return match

    def create_managed(self, display_name: str) -> WorkspaceRecord:
        name, key = _workspace_name(display_name)
        managed = self._safe_managed_root()
        created: Path | None = None

        def update(state: _State) -> tuple[WorkspaceRecord, bool]:
            self._require_workspace_capacity(state)
            nonlocal created
            self._require_unique_workspace_name(state, key)
            workspace_id = self._new_id()
            prefix = _slug_prefix(name)
            candidate = managed / f"{prefix}-{workspace_id[-12:]}"
            if candidate.parent != managed or candidate.exists() or candidate.is_symlink():
                raise ProjectStateError("workspace_path_conflict")
            try:
                candidate.mkdir(mode=0o700)
                candidate.chmod(0o700)
                canonical = candidate.resolve(strict=True)
            except OSError:
                raise ProjectStateError("workspace_create_failed") from None
            if canonical.parent != managed or canonical != candidate:
                try:
                    candidate.rmdir()
                except OSError:
                    pass
                raise ProjectStateError("workspace_boundary_changed")
            created = candidate
            stamp = self._stamp()
            record = WorkspaceRecord(
                workspace_id=workspace_id,
                display_name=name,
                normalized_name=key,
                canonical_path=str(canonical),
                origin="managed",
                codex_home_key=f"home-{workspace_id}",
                active_session_id=None,
                created_at=stamp,
                last_used_at=stamp,
            )
            state.workspaces[workspace_id] = record
            state.active_workspace_id = workspace_id
            return record, True

        try:
            return self._transaction(update)
        except BaseException:
            if created is not None:
                try:
                    created.rmdir()
                except OSError:
                    pass
            raise

    def validate_managed_create(self, display_name: str) -> str:
        name, key = _workspace_name(display_name)

        def read(state: _State) -> tuple[str, bool]:
            self._require_workspace_capacity(state)
            self._require_unique_workspace_name(state, key)
            return name, False

        return self._transaction(read)

    def rollback_managed_create(self, workspace_id: str, *, wait: bool = False) -> bool:
        removed: Path | None = None

        def update(state: _State) -> tuple[bool, bool]:
            nonlocal removed
            record = state.workspaces.get(workspace_id)
            if record is None or record.origin != "managed":
                return False, False
            if any(item.workspace_id == workspace_id for item in state.sessions.values()):
                return False, False
            path = Path(record.canonical_path)
            try:
                if path.is_symlink() or any(path.iterdir()):
                    return False, False
                path.rmdir()
            except OSError:
                return False, False
            removed = path
            del state.workspaces[workspace_id]
            if state.active_workspace_id == workspace_id:
                # Hand the active slot back to the most recently used survivor
                # rather than an arbitrary dict-order entry, so a rolled-back
                # create restores the workspace the user was in before it.
                replacement = max(
                    state.workspaces.values(),
                    key=lambda item: (item.last_used_at, item.created_at, item.workspace_id),
                    default=None,
                )
                state.active_workspace_id = (
                    None if replacement is None else replacement.workspace_id
                )
            return True, True

        try:
            return self._transaction(update, wait=wait)
        except BaseException:
            if removed is not None:
                try:
                    removed.mkdir(mode=0o700)
                except OSError:
                    pass
            raise

    def register_workspace(self, display_name: str, path: Path) -> WorkspaceRecord:
        name, key = _workspace_name(display_name)
        canonical = _registered_path(path)

        def update(state: _State) -> tuple[WorkspaceRecord, bool]:
            self._require_workspace_capacity(state)
            self._require_unique_workspace_name(state, key)
            if any(item.canonical_path == str(canonical) for item in state.workspaces.values()):
                raise ProjectStateError("workspace_path_conflict")
            record = self._new_workspace(
                display_name=name,
                normalized_name=key,
                path=canonical,
                origin="registered",
            )
            state.workspaces[record.workspace_id] = record
            if state.active_workspace_id is None:
                state.active_workspace_id = record.workspace_id
            return record, True

        return self._transaction(update)

    def select_workspace(self, display_name: str) -> WorkspaceRecord:
        _name, key = _workspace_name(display_name)

        def update(state: _State) -> tuple[WorkspaceRecord, bool]:
            record = next(
                (item for item in state.workspaces.values() if item.normalized_name == key),
                None,
            )
            if record is None:
                raise ProjectStateError("workspace_not_found")
            stamp = self._stamp()
            record = replace(record, last_used_at=stamp)
            state.workspaces[record.workspace_id] = record
            changed = state.active_workspace_id != record.workspace_id
            state.active_workspace_id = record.workspace_id
            return record, changed or True

        return self._transaction(update)

    def select_workspace_exact(
        self,
        display_name: str,
        workspace_id: str,
    ) -> WorkspaceRecord:
        """Select the exact workspace confirmed by the user under one registry lock."""

        _name, key = _workspace_name(display_name)

        def update(state: _State) -> tuple[WorkspaceRecord, bool]:
            found = state.workspaces.get(workspace_id)
            if found is None or found.normalized_name != key:
                raise ProjectStateError("workspace_boundary_changed")
            self._revalidate_workspace_record(found)
            record = replace(found, last_used_at=self._stamp())
            state.workspaces[workspace_id] = record
            state.active_workspace_id = workspace_id
            return record, True

        return self._transaction(update)

    def revalidate_workspace(self, workspace_id: str) -> Path:
        record = self._workspace_by_id(workspace_id)
        return self._revalidate_workspace_record(record)

    def _revalidate_workspace_record(self, record: WorkspaceRecord) -> Path:
        path = Path(record.canonical_path)
        try:
            if path.is_symlink() or not path.is_dir():
                raise OSError
            canonical = path.resolve(strict=True)
        except (OSError, RuntimeError):
            raise ProjectStateError("workspace_boundary_changed") from None
        if canonical != path:
            raise ProjectStateError("workspace_boundary_changed")
        if record.origin == "managed" and canonical.parent != self._safe_managed_root():
            raise ProjectStateError("workspace_boundary_changed")
        return canonical

    def begin_session(
        self,
        workspace_id: str,
        display_title: str | None,
    ) -> ProjectSessionRecord:
        def update(state: _State) -> tuple[ProjectSessionRecord, bool]:
            workspace = state.workspaces.get(workspace_id)
            if workspace is None:
                raise ProjectStateError("workspace_not_found")
            self._prune_for_session_insert(state, workspace_id)
            stamp = self._stamp()
            base_title = (
                _session_title(display_title)[0]
                if display_title is not None
                else self._next_default_session_title(state, workspace_id)
            )
            title = self._unique_session_title(state, workspace_id, base_title)
            _display, key = _session_title(title)
            session_id = self._new_id()
            session = ProjectSessionRecord(
                session_id=session_id,
                workspace_id=workspace_id,
                display_title=title,
                normalized_title=key,
                codex_thread_id=None,
                state="starting",
                created_at=stamp,
                last_used_at=stamp,
            )
            state.sessions[session_id] = session
            state.workspaces[workspace_id] = replace(
                workspace,
                active_session_id=session_id,
                last_used_at=stamp,
            )
            state.active_workspace_id = workspace_id
            return session, True

        return self._transaction(update)

    def rollback_session_start(self, session_id: str, *, wait: bool = False) -> bool:
        def update(state: _State) -> tuple[bool, bool]:
            session = state.sessions.get(session_id)
            if (
                session is None
                or session.state != "starting"
                or session.codex_thread_id is not None
            ):
                return False, False
            workspace = state.workspaces.get(session.workspace_id)
            del state.sessions[session_id]
            if workspace is not None and workspace.active_session_id == session_id:
                replacement = max(
                    (
                        item
                        for item in state.sessions.values()
                        if item.workspace_id == workspace.workspace_id and item.state == "ready"
                    ),
                    key=lambda item: (item.last_used_at, item.created_at, item.session_id),
                    default=None,
                )
                state.workspaces[workspace.workspace_id] = replace(
                    workspace,
                    active_session_id=None if replacement is None else replacement.session_id,
                )
            return True, True

        return self._transaction(update, wait=wait)

    def mark_session_ready(
        self, session_id: str, thread_id: str, *, wait: bool = False
    ) -> ProjectSessionRecord:
        clean_thread_id = _thread_id(thread_id)

        def update(state: _State) -> tuple[ProjectSessionRecord, bool]:
            session = state.sessions.get(session_id)
            if session is None:
                raise ProjectStateError("session_not_found")
            if session.state != "starting" or session.codex_thread_id is not None:
                raise ProjectStateError("session_state_conflict")
            ready = replace(
                session,
                codex_thread_id=clean_thread_id,
                state="ready",
                last_used_at=self._stamp(),
            )
            state.sessions[session_id] = ready
            return ready, True

        return self._transaction(update, wait=wait)

    def mark_session_unavailable(
        self, session_id: str, *, wait: bool = False
    ) -> ProjectSessionRecord:
        def update(state: _State) -> tuple[ProjectSessionRecord, bool]:
            session = state.sessions.get(session_id)
            if session is None:
                raise ProjectStateError("session_not_found")
            unavailable = replace(
                session,
                state="unavailable",
                last_used_at=self._stamp(),
            )
            state.sessions[session_id] = unavailable
            changed = unavailable != session
            # An unavailable session must not stay the workspace default:
            # resolve_session(workspace, None) would keep resolving it and
            # every bare resume would fail even when ready sessions exist.
            workspace = state.workspaces.get(session.workspace_id)
            if workspace is not None and workspace.active_session_id == session_id:
                replacement = max(
                    (
                        item
                        for item in state.sessions.values()
                        if item.workspace_id == workspace.workspace_id and item.state == "ready"
                    ),
                    key=lambda item: (item.last_used_at, item.created_at, item.session_id),
                    default=None,
                )
                state.workspaces[workspace.workspace_id] = replace(
                    workspace,
                    active_session_id=None if replacement is None else replacement.session_id,
                )
                changed = True
            return unavailable, changed

        return self._transaction(update, wait=wait)

    def activate_session(
        self,
        workspace_id: str,
        session_id: str,
    ) -> ProjectSessionRecord:
        def update(state: _State) -> tuple[ProjectSessionRecord, bool]:
            workspace = state.workspaces.get(workspace_id)
            session = state.sessions.get(session_id)
            if workspace is None:
                raise ProjectStateError("workspace_not_found")
            if session is None or session.workspace_id != workspace_id:
                raise ProjectStateError("session_workspace_mismatch")
            if session.state != "ready" or session.codex_thread_id is None:
                raise ProjectStateError("session_unavailable")
            stamp = self._stamp()
            state.workspaces[workspace_id] = replace(
                workspace,
                active_session_id=session_id,
                last_used_at=stamp,
            )
            session = replace(session, last_used_at=stamp)
            state.sessions[session_id] = session
            state.active_workspace_id = workspace_id
            return session, True

        return self._transaction(update)

    def public_view(self, *, pending_confirmation: bool) -> PublicProjectView:
        snapshot = self.snapshot()
        workspace = next(
            (
                item
                for item in snapshot.workspaces
                if item.workspace_id == snapshot.active_workspace_id
            ),
            None,
        )
        session = (
            None
            if workspace is None or workspace.active_session_id is None
            else next(
                (
                    item
                    for item in snapshot.sessions
                    if item.session_id == workspace.active_session_id
                ),
                None,
            )
        )
        return PublicProjectView(
            workspace_display_name=None if workspace is None else workspace.display_name,
            session_title=None if session is None else session.display_title,
            pending_confirmation=pending_confirmation,
        )

    def _workspace_by_id(self, workspace_id: str) -> WorkspaceRecord:
        record = next(
            (item for item in self.snapshot().workspaces if item.workspace_id == workspace_id),
            None,
        )
        if record is None:
            raise ProjectStateError("workspace_not_found")
        return record

    def _new_workspace(
        self,
        *,
        display_name: str,
        normalized_name: str,
        path: Path,
        origin: Literal["managed", "registered"],
    ) -> WorkspaceRecord:
        workspace_id = self._new_id()
        stamp = self._stamp()
        return WorkspaceRecord(
            workspace_id=workspace_id,
            display_name=display_name,
            normalized_name=normalized_name,
            canonical_path=str(path),
            origin=origin,
            codex_home_key=f"home-{workspace_id}",
            active_session_id=None,
            created_at=stamp,
            last_used_at=stamp,
        )

    def _new_id(self) -> str:
        value = self._id_factory()
        if type(value) is not str or _ID.fullmatch(value) is None:
            raise ProjectStateError("id_factory_invalid")
        return value

    def _stamp(self) -> float:
        value = self._now()
        if type(value) not in {float, int} or isinstance(value, bool) or not math.isfinite(value):
            raise ProjectStateError("clock_invalid")
        return float(value)

    @staticmethod
    def _require_unique_workspace_name(state: _State, key: str) -> None:
        if any(item.normalized_name == key for item in state.workspaces.values()):
            raise ProjectStateError("workspace_name_conflict")

    @staticmethod
    def _require_workspace_capacity(state: _State) -> None:
        if len(state.workspaces) >= MAX_WORKSPACES:
            raise ProjectStateError("workspace_limit")

    @staticmethod
    def _unique_workspace_name(state: _State, base: str) -> str:
        existing = {item.normalized_name for item in state.workspaces.values()}
        if _workspace_name(base)[1] not in existing:
            return base
        suffix = 2
        while True:
            clipped = base[: max(1, MAX_WORKSPACE_NAME - len(f" ({suffix})"))].rstrip()
            candidate = f"{clipped} ({suffix})"
            if _workspace_name(candidate)[1] not in existing:
                return candidate
            suffix += 1

    @staticmethod
    def _next_default_session_title(state: _State, workspace_id: str) -> str:
        used = [
            int(match.group(1))
            for item in state.sessions.values()
            if item.workspace_id == workspace_id
            and (match := _DEFAULT_SESSION_TITLE.fullmatch(item.display_title)) is not None
        ]
        return f"任务 {max(used, default=0) + 1}"

    @staticmethod
    def _prune_for_session_insert(state: _State, workspace_id: str) -> None:
        def workspace_count() -> int:
            return sum(item.workspace_id == workspace_id for item in state.sessions.values())

        while (
            workspace_count() >= MAX_SESSIONS_PER_WORKSPACE
            or len(state.sessions) >= MAX_SESSIONS_TOTAL
        ):
            active_session_ids = {
                item.active_session_id
                for item in state.workspaces.values()
                if item.active_session_id is not None
            }
            target_only = workspace_count() >= MAX_SESSIONS_PER_WORKSPACE
            candidates = [
                item
                for item in state.sessions.values()
                if item.state != "starting"
                and item.session_id not in active_session_ids
                and (not target_only or item.workspace_id == workspace_id)
            ]
            if not candidates:
                raise ProjectStateError("session_limit")
            candidate = min(
                candidates,
                key=lambda item: (
                    0 if item.state == "unavailable" else 1,
                    item.last_used_at,
                    item.created_at,
                    item.session_id,
                ),
            )
            del state.sessions[candidate.session_id]

    @staticmethod
    def _unique_session_title(state: _State, workspace_id: str, base: str) -> str:
        existing = {
            item.normalized_title
            for item in state.sessions.values()
            if item.workspace_id == workspace_id
        }
        _display, key = _session_title(base)
        if key not in existing:
            return base
        suffix = 2
        while True:
            clipped = base[: max(1, MAX_SESSION_TITLE - len(f" ({suffix})"))].rstrip()
            candidate = f"{clipped} ({suffix})"
            if _session_title(candidate)[1] not in existing:
                return candidate
            suffix += 1

    def _safe_managed_root(self) -> Path:
        root = self.managed_root
        try:
            if root.is_symlink():
                raise OSError
            if not root.exists():
                root.mkdir(parents=True, mode=0o700)
                root.chmod(0o700)
            info = root.stat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != _uid():
                raise OSError
            if info.st_mode & 0o022:
                raise OSError
            canonical = root.resolve(strict=True)
        except (OSError, RuntimeError):
            raise ProjectStateError("managed_root_unsafe") from None
        if canonical != root:
            raise ProjectStateError("managed_root_unsafe")
        return canonical

    def _transaction(
        self,
        operation: Callable[[_State], tuple[_T, bool]],
        *,
        wait: bool = False,
    ) -> _T:
        if fcntl is None:
            raise ProjectStateError("state_lock_failed")
        self._ensure_state_root()
        fd = self._open_lock()
        acquired = False
        try:
            try:
                flags = fcntl.LOCK_EX if wait else fcntl.LOCK_EX | fcntl.LOCK_NB
                fcntl.flock(fd, flags)
                acquired = True
            except OSError as failure:
                if failure.errno in {errno.EACCES, errno.EAGAIN}:
                    raise ProjectStateError("state_busy") from None
                raise ProjectStateError("state_lock_failed") from None
            should_recover = self._recover_starting and not self._startup_loaded
            state, recovered = self._load_state(recover_starting=should_recover)
            result, changed = operation(state)
            if recovered or changed:
                self._save_state(state)
            self._startup_loaded = True
            return result
        finally:
            try:
                if acquired:
                    fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)

    def _ensure_state_root(self) -> None:
        path = self.state_root
        try:
            if path.is_symlink():
                raise OSError
            if not path.exists():
                path.mkdir(parents=True, mode=0o700)
                path.chmod(0o700)
            info = path.stat()
            if (
                not stat.S_ISDIR(info.st_mode)
                or info.st_uid != _uid()
                or stat.S_IMODE(info.st_mode) != 0o700
            ):
                raise OSError
        except OSError:
            raise ProjectStateError("state_permissions") from None

    def _open_lock(self) -> int:
        flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            fd = os.open(self.lock_path, flags, 0o600)
            info = os.fstat(fd)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != _uid()
                or stat.S_IMODE(info.st_mode) != 0o600
            ):
                raise OSError
            return fd
        except OSError:
            try:
                os.close(fd)
            except (OSError, UnboundLocalError):
                pass
            raise ProjectStateError("state_permissions") from None

    def _open_owner_lock(self) -> int:
        if fcntl is None:
            raise ProjectStateError("state_lock_failed")
        flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            fd = os.open(self.owner_lock_path, flags, 0o600)
            info = os.fstat(fd)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != _uid()
                or stat.S_IMODE(info.st_mode) != 0o600
            ):
                raise OSError
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as failure:
                if failure.errno in {errno.EACCES, errno.EAGAIN}:
                    raise ProjectStateError("state_busy") from None
                raise
            return fd
        except ProjectStateError:
            try:
                os.close(fd)
            except (OSError, UnboundLocalError):
                pass
            raise
        except OSError:
            try:
                os.close(fd)
            except (OSError, UnboundLocalError):
                pass
            raise ProjectStateError("state_permissions") from None

    def _load_state(self, *, recover_starting: bool) -> tuple[_State, bool]:
        path = self.state_path
        flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0)
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            fd = os.open(path, flags)
        except FileNotFoundError:
            return _State(active_workspace_id=None, workspaces={}, sessions={}), False
        try:
            info = os.fstat(fd)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != _uid()
                or stat.S_IMODE(info.st_mode) != 0o600
            ):
                raise ProjectStateError("state_permissions")
            if info.st_size > MAX_STATE_BYTES:
                raise ProjectStateError("state_too_large")
            with os.fdopen(fd, "rb", closefd=True) as stream:
                fd = -1
                raw = stream.read(MAX_STATE_BYTES + 1)
            if len(raw) > MAX_STATE_BYTES:
                raise ProjectStateError("state_too_large")
            value = json.loads(raw)
            state = _decode_state(value)
        except ProjectStateError:
            raise
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
            raise ProjectStateError("state_corrupt") from None
        finally:
            if fd >= 0:
                os.close(fd)
        recovered = False
        if recover_starting:
            for session_id, session in tuple(state.sessions.items()):
                if session.state == "starting" and session.codex_thread_id is None:
                    state.sessions[session_id] = replace(session, state="unavailable")
                    recovered = True
        return state, recovered

    def _save_state(self, state: _State) -> None:
        payload = _encode_state(state)
        try:
            raw = json.dumps(
                payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
        except (TypeError, ValueError):
            raise ProjectStateError("state_corrupt") from None
        if len(raw) > MAX_STATE_BYTES:
            raise ProjectStateError("state_too_large")
        temp = self.state_root / f".{STATE_FILE}.{uuid4().hex}.tmp"
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd: int | None = None
        try:
            fd = os.open(temp, flags, 0o600)
            with os.fdopen(fd, "wb", closefd=True) as stream:
                fd = None
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, self.state_path)
            directory_fd = os.open(self.state_root, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            raise ProjectStateError("state_write_failed") from None
        finally:
            if fd is not None:
                os.close(fd)
            try:
                temp.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                pass


def _uid() -> int:
    return os.getuid() if hasattr(os, "getuid") else os.stat(Path.home()).st_uid


def _snapshot(state: _State) -> ProjectSnapshot:
    workspaces = tuple(sorted(state.workspaces.values(), key=lambda item: item.created_at))
    sessions = tuple(sorted(state.sessions.values(), key=lambda item: item.created_at))
    return ProjectSnapshot(
        version=STATE_VERSION,
        active_workspace_id=state.active_workspace_id,
        workspaces=workspaces,
        sessions=sessions,
    )


def _workspace_name(value: object) -> tuple[str, str]:
    display, key = _public_text(value, max_length=MAX_WORKSPACE_NAME, code="workspace_name_invalid")
    if (
        "/" in display
        or "\\" in display
        or "://" in display
        or _DRIVE.match(display)
        or display in {".", ".."}
        or any(part in {".", ".."} for part in re.split(r"[/\\]", display))
    ):
        raise ProjectStateError("workspace_name_invalid")
    return display, key


def _session_title(value: object) -> tuple[str, str]:
    return _public_text(value, max_length=MAX_SESSION_TITLE, code="session_title_invalid")


def _public_text(value: object, *, max_length: int, code: str) -> tuple[str, str]:
    if type(value) is not str:
        raise ProjectStateError(code)
    display = " ".join(unicodedata.normalize("NFKC", value).strip().split())
    if (
        not display
        or len(display) > max_length
        or any(unicodedata.category(char).startswith("C") for char in display)
    ):
        raise ProjectStateError(code)
    return display, display.casefold()


def _slug_prefix(display: str) -> str:
    pieces: list[str] = []
    for char in display.casefold():
        if char.isalnum():
            pieces.append(char)
        elif char.isspace() or char in {"-", "_"}:
            if pieces and pieces[-1] != "-":
                pieces.append("-")
    prefix = "".join(pieces).strip("-")[:32].rstrip("-")
    return prefix or "workspace"


def _registered_path(path: Path) -> Path:
    try:
        candidate = path.expanduser().absolute()
        if candidate.is_symlink() or not candidate.is_dir():
            raise OSError
        canonical = candidate.resolve(strict=True)
    except (OSError, RuntimeError):
        raise ProjectStateError("workspace_invalid") from None
    if canonical != candidate:
        raise ProjectStateError("workspace_invalid")
    return canonical


def _thread_id(value: object) -> str:
    if (
        type(value) is not str
        or not 1 <= len(value) <= 256
        or any(unicodedata.category(char).startswith("C") for char in value)
    ):
        raise ProjectStateError("thread_id_invalid")
    return value


def _encode_state(state: _State) -> dict[str, Any]:
    return {
        "version": STATE_VERSION,
        "active_workspace_id": state.active_workspace_id,
        "workspaces": {
            key: {
                "workspace_id": value.workspace_id,
                "display_name": value.display_name,
                "normalized_name": value.normalized_name,
                "canonical_path": value.canonical_path,
                "origin": value.origin,
                "codex_home_key": value.codex_home_key,
                "active_session_id": value.active_session_id,
                "created_at": value.created_at,
                "last_used_at": value.last_used_at,
            }
            for key, value in state.workspaces.items()
        },
        "sessions": {
            key: {
                "session_id": value.session_id,
                "workspace_id": value.workspace_id,
                "display_title": value.display_title,
                "normalized_title": value.normalized_title,
                "codex_thread_id": value.codex_thread_id,
                "state": value.state,
                "created_at": value.created_at,
                "last_used_at": value.last_used_at,
            }
            for key, value in state.sessions.items()
        },
    }


def _decode_state(value: object) -> _State:
    if type(value) is not dict or set(value) != {
        "version",
        "active_workspace_id",
        "workspaces",
        "sessions",
    }:
        raise ValueError
    if value["version"] != STATE_VERSION:
        raise ProjectStateError("state_version_unsupported")
    raw_workspaces = value["workspaces"]
    raw_sessions = value["sessions"]
    if type(raw_workspaces) is not dict or type(raw_sessions) is not dict:
        raise ValueError
    if len(raw_workspaces) > MAX_WORKSPACES or len(raw_sessions) > MAX_SESSIONS_TOTAL:
        raise ValueError
    workspaces: dict[str, WorkspaceRecord] = {}
    for key, raw in raw_workspaces.items():
        record = _decode_workspace(raw)
        if key != record.workspace_id or key in workspaces:
            raise ValueError
        workspaces[key] = record
    sessions: dict[str, ProjectSessionRecord] = {}
    for key, raw in raw_sessions.items():
        record = _decode_session(raw)
        if key != record.session_id or key in sessions or record.workspace_id not in workspaces:
            raise ValueError
        sessions[key] = record
    active = value["active_workspace_id"]
    if active is not None and (type(active) is not str or active not in workspaces):
        raise ValueError
    if len({item.normalized_name for item in workspaces.values()}) != len(workspaces):
        raise ValueError
    for workspace in workspaces.values():
        if workspace.active_session_id is not None:
            session = sessions.get(workspace.active_session_id)
            if session is None or session.workspace_id != workspace.workspace_id:
                raise ValueError
        if (
            sum(session.workspace_id == workspace.workspace_id for session in sessions.values())
            > MAX_SESSIONS_PER_WORKSPACE
        ):
            raise ValueError
    seen_titles: set[tuple[str, str]] = set()
    for session in sessions.values():
        title_key = (session.workspace_id, session.normalized_title)
        if title_key in seen_titles:
            raise ValueError
        seen_titles.add(title_key)
    return _State(active_workspace_id=active, workspaces=workspaces, sessions=sessions)


def _decode_workspace(value: object) -> WorkspaceRecord:
    fields = {
        "workspace_id",
        "display_name",
        "normalized_name",
        "canonical_path",
        "origin",
        "codex_home_key",
        "active_session_id",
        "created_at",
        "last_used_at",
    }
    if type(value) is not dict or set(value) != fields:
        raise ValueError
    workspace_id = _stored_id(value["workspace_id"])
    display, normalized = _workspace_name(value["display_name"])
    if value["normalized_name"] != normalized:
        raise ValueError
    canonical = value["canonical_path"]
    if type(canonical) is not str or not Path(canonical).is_absolute():
        raise ValueError
    origin = value["origin"]
    if origin not in {"managed", "registered"}:
        raise ValueError
    home_key = value["codex_home_key"]
    if type(home_key) is not str or home_key != f"home-{workspace_id}":
        raise ValueError
    active_session = value["active_session_id"]
    if active_session is not None:
        active_session = _stored_id(active_session)
    return WorkspaceRecord(
        workspace_id=workspace_id,
        display_name=display,
        normalized_name=normalized,
        canonical_path=canonical,
        origin=origin,
        codex_home_key=home_key,
        active_session_id=active_session,
        created_at=_timestamp(value["created_at"]),
        last_used_at=_timestamp(value["last_used_at"]),
    )


def _decode_session(value: object) -> ProjectSessionRecord:
    fields = {
        "session_id",
        "workspace_id",
        "display_title",
        "normalized_title",
        "codex_thread_id",
        "state",
        "created_at",
        "last_used_at",
    }
    if type(value) is not dict or set(value) != fields:
        raise ValueError
    display, normalized = _session_title(value["display_title"])
    if value["normalized_title"] != normalized:
        raise ValueError
    state = value["state"]
    if state not in {"starting", "ready", "unavailable"}:
        raise ValueError
    thread_id = value["codex_thread_id"]
    if thread_id is not None:
        thread_id = _thread_id(thread_id)
    if state == "ready" and thread_id is None:
        raise ValueError
    return ProjectSessionRecord(
        session_id=_stored_id(value["session_id"]),
        workspace_id=_stored_id(value["workspace_id"]),
        display_title=display,
        normalized_title=normalized,
        codex_thread_id=thread_id,
        state=state,
        created_at=_timestamp(value["created_at"]),
        last_used_at=_timestamp(value["last_used_at"]),
    )


def _stored_id(value: object) -> str:
    if type(value) is not str or _ID.fullmatch(value) is None:
        raise ValueError
    return value


def _timestamp(value: object) -> float:
    if type(value) not in {int, float} or isinstance(value, bool) or not math.isfinite(value):
        raise ValueError
    return float(value)


__all__ = [
    "CodexProjectStore",
    "ProjectSessionRecord",
    "ProjectSnapshot",
    "ProjectStateError",
    "PublicProjectView",
    "WorkspaceRecord",
]
