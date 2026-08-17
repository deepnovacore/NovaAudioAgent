# Codex Multi-Workspace and Persistent Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add host-owned multi-workspace selection, safe voice workspace creation, and real persistent Codex Session resume while keeping one globally serialized Codex task and only one new Qwen-visible function.

**Architecture:** A locked atomic `CodexProjectStore` owns private workspace and Session metadata. `ProjectCodexAdapter` extends the existing live Codex lifecycle with a workspace-scoped transport factory and a single `codex__project` proposal tool; `ProjectConfirmationController` reserves the next ASR item and only a deterministic host grammar can commit a prepared proposal. Persistent transports use one durable CODEX_HOME per workspace and either non-ephemeral `thread/start` or validated `thread/resume`, while Runtime and DelegateLedger remain the sole task lifecycle.

**Tech Stack:** Python 3.12, asyncio, Pydantic Settings, Typer, JSON-RPC Codex app-server 0.145.0 schema, pytest/pytest-asyncio, Electron renderer ES modules, Node 22 test runner.

## Global Constraints

- Project mode is opt-in through `NOVA_AUDIO_AGENT_CODEX_PROJECTS_ENABLED=false` by default.
- Managed voice-created workspaces are direct children of `NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT`, default `~/NovaWorkspaces`; voice never supplies a path.
- Project state defaults to `NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT=~/.nova-audio-agent`.
- State files and copied credentials are `0600`; state directories and workspace CODEX_HOMEs are `0700`.
- Workspace A and B use distinct persistent CODEX_HOMEs and cannot resume each other's thread IDs.
- A new run creates a new non-ephemeral Session; only confirmed resume reuses an existing thread.
- Every work order still owns a fresh app-server process and all clean/failure/cancel teardown behavior from Phase 1 remains intact.
- One global Codex run slot remains authoritative; no task-specific status, steer, cancel, or concurrency is added.
- The provider sees exactly `codex__run`, `codex__project`, `codex__status`, and `codex__steer` in project mode.
- Canonical paths, opaque IDs, thread IDs, CODEX_HOME keys, nonces, and registry bodies never enter provider schemas, speech, captions, Memory, trace projections, or Orb payloads.
- Create, select, and resume have zero durable effect before host confirmation.
- Confirmation uses exact whole-utterance grammar with negative precedence; no LLM classification, edit distance, or fuzzy substring authorization.
- Existing single-workspace behavior is unchanged while project mode is disabled.

---

### Task 1: Locked Atomic Workspace and Session Registry

**Files:**
- Create: `src/nova_audio_agent/executors/codex_projects.py`
- Create: `tests/test_codex_projects.py`

**Interfaces:**
- Produces immutable `WorkspaceRecord`, `ProjectSessionRecord`, `ProjectSnapshot`, and `PublicProjectView` dataclasses.
- Produces `CodexProjectStore(state_root: Path, managed_root: Path, *, now: Callable[[], float], id_factory: Callable[[], str])`.
- Produces exact lookup and mutation methods used later: `ensure_imported`, `snapshot`, `list_workspaces`, `list_sessions`, `resolve_workspace`, `resolve_session`, `revalidate_workspace`, `create_managed`, `rollback_managed_create`, `register_workspace`, `select_workspace`, `begin_session`, `mark_session_ready`, `mark_session_unavailable`, and `activate_session`.
- Produces bounded public exceptions carrying stable codes but no private paths or IDs: `ProjectStateError(code)`.
- `tests/test_codex_projects.py` defines local `make_store(tmp_path)`, `make_workspace(tmp_path, name)`, and `write_state(tmp_path, bytes)` helpers; each returns the real store/path and performs no production behavior itself.

- [ ] **Step 1: Write failing registry format and migration tests**

```python
def test_first_enable_imports_configured_workspace_once_and_restores_active_state(tmp_path):
    workspace = tmp_path / "existing"
    workspace.mkdir()
    store = make_store(tmp_path)
    first = store.ensure_imported("existing", workspace)
    second = store.ensure_imported("existing", workspace)
    assert first.workspace_id == second.workspace_id
    assert store.snapshot().active_workspace_id == first.workspace_id
    assert json.loads((tmp_path / "state" / "codex-projects-v1.json").read_text())["version"] == 1
```

- [ ] **Step 2: Run the migration test and verify RED**

Run: `uv run pytest tests/test_codex_projects.py::test_first_enable_imports_configured_workspace_once_and_restores_active_state -q`

Expected: FAIL because `nova_audio_agent.executors.codex_projects` does not exist.

- [ ] **Step 3: Implement validated dataclasses, version-1 decoding, initial import, and public snapshots**

```python
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
```

Decode every field with closed keys, finite timestamps, bounded strings, ID syntax, referential integrity, and a 1 MiB input limit. Convert persisted `starting` records with null thread IDs to `unavailable` during the first locked recovery transaction.

- [ ] **Step 4: Run the migration test and verify GREEN**

Run: `uv run pytest tests/test_codex_projects.py::test_first_enable_imports_configured_workspace_once_and_restores_active_state -q`

Expected: PASS.

- [ ] **Step 5: Write failing atomicity, permissions, corruption, and lost-update tests**

```python
def test_two_store_instances_reload_under_lock_instead_of_losing_updates(tmp_path):
    first = make_store(tmp_path)
    second = make_store(tmp_path)
    first.ensure_imported("one", make_workspace(tmp_path, "one"))
    second.register_workspace("two", make_workspace(tmp_path, "two"))
    assert [item.display_name for item in first.list_workspaces()] == ["one", "two"]

def test_corrupt_registry_is_preserved_and_fails_closed(tmp_path):
    path = write_state(tmp_path, b'{"version":1,"workspaces":')
    with pytest.raises(ProjectStateError, match="state_corrupt"):
        make_store(tmp_path).snapshot()
    assert path.read_bytes() == b'{"version":1,"workspaces":'
```

Also cover state/lock file `0600`, directories `0700`, unsafe owner/mode rejection, fsync-before-rename ordering through a narrow filesystem seam, and no private path in `repr(exc)`.

- [ ] **Step 6: Implement the interprocess transaction and atomic writer**

Use `fcntl.flock(LOCK_EX)` on `codex-projects-v1.lock`; inside every transaction reload and validate current JSON, write a same-directory exclusive temporary file, `fsync` it, `os.replace`, then `fsync` the directory. Clear raw decoded objects before returning and never include a path in an exception message.

- [ ] **Step 7: Run registry durability tests and verify GREEN**

Run: `uv run pytest tests/test_codex_projects.py -q`

Expected: all durability tests pass.

- [ ] **Step 8: Write failing name, managed-create, rollback, and revalidation tests**

```python
@pytest.mark.parametrize("name", ["", "../escape", "a/b", "file://x", "C:\\x", "\x00"])
def test_managed_creation_rejects_path_like_voice_names(tmp_path, name):
    with pytest.raises(ProjectStateError):
        make_store(tmp_path).create_managed(name)

def test_managed_creation_is_one_real_direct_child_and_empty_only_rollback(tmp_path):
    store = make_store(tmp_path)
    workspace = store.create_managed("天气看板")
    path = Path(workspace.canonical_path)
    assert path.parent == (tmp_path / "managed").resolve()
    path.joinpath("keep.txt").write_text("user data")
    store.rollback_managed_create(workspace.workspace_id)
    assert path.exists()
```

Cover NFKC/case-fold collisions, pre-existing candidate refusal, symlink managed root/candidate refusal, owner-controlled root checks, exact-name-only resolution, registered workspace canonical revalidation, distinct CODEX_HOME keys, Session title collisions, state transitions, and cross-workspace Session lookup refusal.

- [ ] **Step 9: Implement workspace and Session transactions**

Managed directory names use a sanitized printable prefix plus an opaque host suffix; path containment is checked after canonicalization before `mkdir`. `begin_session` writes `starting`; `mark_session_ready` requires the same workspace and a non-empty thread ID; `activate_session` updates both workspace active Session and last-used timestamps in one transaction.

- [ ] **Step 10: Run all registry tests and commit**

Run: `uv run pytest tests/test_codex_projects.py -q`

Then:

```bash
git add src/nova_audio_agent/executors/codex_projects.py tests/test_codex_projects.py
git commit -m "feat: add locked codex project registry"
```

---

### Task 2: Deterministic Proposal and Confirmation Controller

**Files:**
- Create: `src/nova_audio_agent/realtime/project_confirmation.py`
- Create: `tests/test_project_confirmation.py`

**Interfaces:**
- Consumes public/private resolved records from `codex_projects.py` but never serializes private fields.
- Produces `ProjectProposal`, `ConfirmedProjectOperation`, `ConfirmationOutcome`, and `ProjectConfirmationView`.
- Produces `ProjectConfirmationController(clock: Clock, id_factory: Callable[[], str], on_change: Callable[[ProjectConfirmationView], None] | None = None)` with `prepare`, `reserve_user_item`, `accept_transcript`, `claim_confirmed`, `fail_transcript`, `invalidate`, and `expire`.
- `tests/test_project_confirmation.py` defines `make_controller(clock)` and `make_select_proposal()` as literal constructors for the public controller/proposal types.

- [ ] **Step 1: Write a failing table-driven whole-utterance grammar test**

```python
@pytest.mark.parametrize("text", ["确认", "嗯，确认执行！", "好的，可以", "那就按这个来呀", "开始吧"])
def test_affirmative_grammar_accepts_only_bounded_whole_utterances(text):
    assert classify_confirmation(text) == "confirm"

@pytest.mark.parametrize("text", ["取消", "不确认", "确认但不要执行", "可以，顺便删除旧项目"])
def test_negative_or_extra_objective_never_confirms(text):
    assert classify_confirmation(text) != "confirm"
```

- [ ] **Step 2: Run the grammar tests and verify RED**

Run: `uv run pytest tests/test_project_confirmation.py -q`

Expected: FAIL because the module and classifier do not exist.

- [ ] **Step 3: Implement exact normalization and negative precedence**

Strip Unicode punctuation and whitespace. The exact positive cores are `确认`, `确认执行`, `可以`, `可以执行`, `同意`, `没问题`, `就这么做`, `按这个来`, `开始吧`, `执行吧`, and `做吧`. Permit only leading `嗯`, `嗯嗯`, `好`, `好的`, `那`, or `那就`, and trailing `啊`, `呀`, `哦`, or `啦`. The exact negative forms are `取消`, `不确认`, `不要`, `不行`, `先不要`, `先别`, `算了`, and `停止`; negative or mixed-negative terms win before positive classification. Do not use edit distance, partial-name lookup, substring-positive matching, or a model. A first unrecognized normalized reply of at most 24 characters gets one retry; a longer reply or the second unrecognized reply cancels.

- [ ] **Step 4: Run grammar tests and verify GREEN**

Run: `uv run pytest tests/test_project_confirmation.py -q`

Expected: grammar cases pass.

- [ ] **Step 5: Write failing proposal lifecycle tests**

```python
def test_proposal_has_no_side_effect_and_can_be_consumed_once(clock):
    controller = make_controller(clock)
    proposal = controller.prepare(make_select_proposal())
    controller.reserve_user_item(epoch=3, item_id="u1")
    first = controller.accept_transcript(epoch=3, item_id="u1", text="确认")
    second = controller.accept_transcript(epoch=3, item_id="u1", text="确认")
    assert first.kind == "confirmed"
    assert second.kind == "ignored"
    assert first.operation.nonce == proposal.nonce
```

Cover one retry then cancel, explicit cancellation, 90-second expiry, newer proposal replacement, wrong epoch/item refusal, ASR failure, provider replacement, restart invalidation, single-use nonce, rejection of a forged/copied operation that has no controller authority, and observer projection containing only public names/title/pending.

- [ ] **Step 6: Implement the in-memory controller and bounded public prompts**

`prepare` stores one proposal with `expires_at=clock.now()+90`; `reserve_user_item` binds exactly one real ASR item. An affirmative `accept_transcript` removes the pending proposal and moves the exact returned `ConfirmedProjectOperation` object into one transient commit-authority slot. `claim_confirmed` accepts that object by identity once and clears the slot; copied, reconstructed, stale, or repeated objects fail. All terminal paths clear private proposal state before invoking `on_change`.

- [ ] **Step 7: Run controller tests and commit**

Run: `uv run pytest tests/test_project_confirmation.py -q`

Then:

```bash
git add src/nova_audio_agent/realtime/project_confirmation.py tests/test_project_confirmation.py
git commit -m "feat: add deterministic project confirmation"
```

---

### Task 3: Persistent CODEX_HOME and Validated Thread Resume

**Files:**
- Modify: `src/nova_audio_agent/executors/codex_app_server_protocol.py`
- Modify: `src/nova_audio_agent/executors/codex_app_server.py`
- Modify: `tests/test_codex_app_server_protocol.py`
- Modify: `tests/test_codex_app_server.py`

**Interfaces:**
- Extends `AppServerTurnProjection.bind_thread(response, *, workspace, ephemeral, expected_thread_id=None)` to validate thread ID, cwd, `runtimeWorkspaceRoots`, `approvalPolicy`, and active permission profile.
- Extends `CodexAppServerTransport(..., codex_home: Path | None = None, resume_thread_id: str | None = None, on_thread_ready: Callable[[str], None] | None = None)`.
- Preserves the old ephemeral temporary-home behavior when `codex_home is None`.
- `tests/test_codex_app_server.py` extends its real fake JSON-RPC peer with `persistent_transport(...)`, `request(method)`, and `methods_between(first, last)` helpers; `tests/test_codex_app_server_protocol.py` defines a complete literal `persistent_thread_response(workspace, thread_id)` fixture matching the generated 0.145.0 response schema.

- [ ] **Step 1: Write failing protocol validation tests for persistent start and resume**

```python
def test_persistent_projection_requires_expected_thread_workspace_roots_and_profile(tmp_path):
    projection = AppServerTurnProjection(clock=VirtualClock(), on_progress=None)
    projection.bind_thread(
        persistent_thread_response(tmp_path, thread_id="thread-a"),
        workspace=tmp_path,
        ephemeral=False,
        expected_thread_id="thread-a",
    )
    assert projection.thread_id == "thread-a"
```

Mutate thread ID, cwd, runtime roots, permission profile, and ephemeral flag one at a time and assert `unsupported_protocol`.

- [ ] **Step 2: Run the protocol tests and verify RED**

Run: `uv run pytest tests/test_codex_app_server_protocol.py -q`

Expected: new persistent calls fail against the old fixed ephemeral signature.

- [ ] **Step 3: Generalize projection validation and schema probing**

Require local generated schemas for `ThreadResumeParams` and `ThreadResumeResponse` in addition to existing start/turn shapes. Accept non-null rollout `thread.path` only in persistent mode but never return or log it.

- [ ] **Step 4: Run protocol tests and verify GREEN**

Run: `uv run pytest tests/test_codex_app_server_protocol.py -q`

Expected: all old ephemeral and new persistent protocol tests pass.

- [ ] **Step 5: Write failing transport request and home-lifecycle tests**

```python
@pytest.mark.asyncio
async def test_persistent_new_session_uses_non_ephemeral_start_and_retains_home(tmp_path):
    home = tmp_path / "state" / "codex-workspaces" / "home-a"
    transport, peer = persistent_transport(tmp_path, home=home)
    await transport.run("do work", on_status=lambda _: None, on_progress=None)
    assert peer.request("thread/start")["ephemeral"] is False
    assert peer.request("thread/start")["runtimeWorkspaceRoots"] == [str(tmp_path)]
    assert home.is_dir()

@pytest.mark.asyncio
async def test_resume_uses_thread_resume_before_turn_start(tmp_path):
    transport, peer = persistent_transport(tmp_path, resume_thread_id="thread-a")
    await transport.run("continue", on_status=lambda _: None, on_progress=None)
    assert peer.methods_between("config/read", "turn/start") == ["thread/resume"]
```

Cover `permissions="nova_audio_agent"`, `cwd`, `excludeTurns=True`, response validation before `turn/start`, callback ordering before turn write, missing history refusal, mismatch refusal, persistent credential copy `0600`, home `0700`, workspace-specific homes, and teardown retaining persistent files. Keep all existing Phase 1 process-reaping tests unchanged.

- [ ] **Step 6: Implement persistent spawn and start/resume establishment**

For a persistent home, reject symlinks/unsafe ownership or modes, create it `0700`, and copy saved-login files only when absent. `_establish` sends `thread/start` for a new Session or `thread/resume` for a stored ID. Invoke `on_thread_ready(thread_id)` after projection validation and immediately before `turn/start`; callback failure refuses before work is written.

- [ ] **Step 7: Run transport tests and commit**

Run: `uv run pytest tests/test_codex_app_server.py tests/test_codex_app_server_protocol.py -q`

Then:

```bash
git add src/nova_audio_agent/executors/codex_app_server.py src/nova_audio_agent/executors/codex_app_server_protocol.py tests/test_codex_app_server.py tests/test_codex_app_server_protocol.py
git commit -m "feat: persist and resume codex app-server threads"
```

---

### Task 4: Project-Aware Codex Adapter and Single Tool Surface

**Files:**
- Create: `src/nova_audio_agent/executors/codex_project_live.py`
- Modify: `src/nova_audio_agent/executors/__init__.py`
- Modify: `src/nova_audio_agent/executors/codex_live.py`
- Create: `tests/test_codex_project_live.py`
- Modify: `tests/test_tool_schema.py`

**Interfaces:**
- Produces `PROJECT_RUN`, `PROJECT`, `CODEX_PROJECT_LIVE_MANIFEST`, and `ProjectCodexAdapter`.
- `PROJECT` is one synchronous, conservatively non-readonly OpSpec with the flat action/workspace/session/work_order schema.
- `ProjectCodexAdapter` consumes `CodexProjectStore`, `ProjectConfirmationController`, and a `worker_factory(workspace, codex_home, resume_thread_id, on_thread_ready) -> CodexLiveWorker`.
- Produces `commit_confirmed(operation, *, origin_ref, runtime_dispatch) -> ProjectCommitResult`, the only commit entry point.
- `tests/test_codex_project_live.py` defines literal fakes/fixtures `project_adapter`, `dispatch_run`, and `confirmed_resume`; `codex_tool_names` filters actual compiled schemas and does not reproduce compiler logic.

- [ ] **Step 1: Write failing manifest and action-validation tests**

```python
def test_project_mode_exposes_one_additional_flat_tool():
    tools = compile_tool_schema((CODEX_PROJECT_LIVE_MANIFEST,))
    names = [item["function"]["name"] for item in tools.schemas if item["function"]["name"].startswith("codex__")]
    assert names == ["codex__run", "codex__project", "codex__steer", "codex__status"]
```

Assert `list` rejects optional fields, `create/select` require exact workspace, `resume` requires complete work order, unknown properties fail, and all public Handoffs omit paths/IDs/nonces.

- [ ] **Step 2: Run manifest tests and verify RED**

Run: `uv run pytest tests/test_codex_project_live.py tests/test_tool_schema.py -q`

Expected: project manifest/module is missing.

- [ ] **Step 3: Implement the project OpSpec and proposal-only dispatch**

`list` and `sessions` return bounded public records. `create`, `select`, and `resume` resolve exact logical names and call `controller.prepare`; they never call a store mutator. Add optional `session` to project-mode run only; disabled-mode `RUN` remains byte-for-byte compatible.

- [ ] **Step 4: Run action tests and verify GREEN**

Run: `uv run pytest tests/test_codex_project_live.py -q`

Expected: public action tests pass.

- [ ] **Step 5: Write failing task-binding, busy, new Session, and resume tests**

```python
@pytest.mark.asyncio
async def test_two_plain_runs_create_distinct_sessions_and_threads_in_the_same_workspace_home(project_adapter):
    first = await dispatch_run(project_adapter, "first")
    second = await dispatch_run(project_adapter, "second")
    assert first.outcome == second.outcome == "ok"
    sessions = project_adapter.store.list_sessions("alpha")
    assert sessions[0].codex_thread_id != sessions[1].codex_thread_id
    assert project_adapter.worker_calls[0].codex_home == project_adapter.worker_calls[1].codex_home

@pytest.mark.asyncio
async def test_confirmed_resume_reuses_thread_but_new_process_and_rejects_cross_workspace(project_adapter):
    operation = confirmed_resume(workspace="alpha", session="Task 1")
    result = await project_adapter.commit_confirmed(operation, origin_ref="user:2", runtime_dispatch=dispatch)
    assert result.accepted is True
    assert project_adapter.worker_calls[-1].resume_thread_id == saved_thread_id
```

Cover immutable `delegate_id -> workspace/session/operation` binding, selection affecting future tasks only, steering current worker only, status current/most recent only, failed thread start marking Session unavailable, failed turn retaining ready Session, active Session persistence, prewarm invalidation after selection, and confirmed resume/create-with-work acquiring the global slot before state mutation. A busy commit and Runtime rejection must leave store state unchanged.

Add an explicit two-workspace case asserting different CODEX_HOME paths and refusal when a Session from workspace A is presented while workspace B is bound. Missing or non-exact names return only a bounded list of public candidates and never choose one.

- [ ] **Step 6: Implement project worker selection and host-owned confirmed dispatch**

Subclass `CodexLiveAdapter` to reuse status/progress/steer/handoff classification. Normal run acquires the inherited global lock, snapshots active workspace, creates `starting`, installs a workspace transport, marks ready through `on_thread_ready`, and binds the delegate immutably. Confirmed work must first succeed at `controller.claim_confirmed(operation)`, reserve the same lock, arm an internal binding keyed by the confirmation `origin_ref`, and submit an ordinary schema-valid host-owned `DelegateRequest(op="run")` through `Runtime.dispatch_external`; no hidden OpSpec is created.

- [ ] **Step 7: Run adapter tests and existing live adapter regression tests**

Run: `uv run pytest tests/test_codex_project_live.py tests/test_codex_live.py tests/test_tool_schema.py -q`

Expected: all pass.

- [ ] **Step 8: Commit the adapter**

```bash
git add src/nova_audio_agent/executors/codex_project_live.py src/nova_audio_agent/executors/codex_live.py src/nova_audio_agent/executors/__init__.py tests/test_codex_project_live.py tests/test_tool_schema.py
git commit -m "feat: route codex work through named projects"
```

---

### Task 5: Realtime Confirmation-Turn Admission and Provider Fencing

**Files:**
- Modify: `src/nova_audio_agent/realtime/session.py`
- Modify: `src/nova_audio_agent/realtime/service.py`
- Modify: `tests/test_realtime_session.py`
- Modify: `tests/test_realtime_service.py`

**Interfaces:**
- Adds `RealtimeSession.arm_next_response_fence()` as the narrow public wrapper around existing one-shot response fencing.
- Adds optional `project_confirmation`, `commit_project_operation`, and `on_project_view` constructor dependencies to `RealtimeService`.
- Confirmation result speech uses existing `HostContextItem` and `HostResponseIntent.host_fact`; no provider tool is used for commit.
- `tests/test_realtime_service.py` extends its existing fake Runtime/bridge harness with literal `prepare_select(controller, name)` and `host_confirmed_request()` helpers that inspect real accepted `DelegateRequest` values.

- [ ] **Step 1: Write a failing session-level pre-start response fence test**

```python
@pytest.mark.asyncio
async def test_reserved_confirmation_response_is_cancelled_before_audio_playback(session, provider, playback):
    session.arm_next_response_fence()
    assert await session.accept(ResponseStarted(session_epoch=1, response_id="r-confirm")) is False
    assert provider.cancelled == ["r-confirm"]
    assert playback.current is None
```

- [ ] **Step 2: Run the session test and verify RED**

Run: `uv run pytest tests/test_realtime_session.py -q`

Expected: public fence method does not exist.

- [ ] **Step 3: Expose the one-shot fence without changing ordinary barge-in behavior**

The method may arm only when no fence is already armed; duplicate arming is idempotent. Existing Guard and renderer fencing tests must remain green.

- [ ] **Step 4: Run session tests and verify GREEN**

Run: `uv run pytest tests/test_realtime_session.py -q`

Expected: all session tests pass.

- [ ] **Step 5: Write failing service tests for the complete confirmation turn**

```python
@pytest.mark.asyncio
async def test_confirmation_asr_is_recorded_but_model_tool_call_cannot_authorize(service, runtime):
    prepare_select(service.project_confirmation, "alpha")
    await service.handle_event(UserSpeechStarted(session_epoch=1, speech_id="s", provider_item_id="u"))
    await service.handle_event(ToolCallReady(session_epoch=1, response_id="r", item_id="i", call_id="c", name="codex__run", arguments={"work_order": "wrong", "origin_ref": "user:1"}))
    await service.handle_event(UserTranscriptFinal(session_epoch=1, item_id="u", text="确认"))
    assert runtime.user_inputs[-1].text == "确认"
    assert runtime.dispatched_requests == [host_confirmed_request()]
```

Cover early tool call before transcript final, response audio/text suppression, exact item correlation, affirmative commit once, negative cancellation, first retry/second cancel, expiry, ASR failure, reconnect/provider replacement cancellation, missing correlation fail-closed, caption remaining user-authored, and host response facts containing public names only.

- [ ] **Step 6: Implement confirmation reservation before normal bridge admission**

At accepted `UserSpeechStarted`, reserve the item and arm the next response fence. At transcript final, always ingest the user evidence first, then classify; do not release deferred provider tool calls for the reserved item. On confirmation invoke the injected commit callback with the confirmation Memory ref. Queue one fixed host fact for confirmed/refused/retry/cancel outcomes. Retain fenced response/item identities until their terminal event so late tool calls cannot escape after nonce consumption.

- [ ] **Step 7: Implement expiry and reconnect invalidation**

Schedule one bounded clock task per proposal generation. Service close and provider reconnect call `invalidate("provider_replaced")`; cancellation and exceptions must clear the task without leaking a proposal.

- [ ] **Step 8: Run realtime tests and commit**

Run: `uv run pytest tests/test_realtime_service.py tests/test_realtime_session.py tests/test_realtime_bridge.py -q`

Then:

```bash
git add src/nova_audio_agent/realtime/session.py src/nova_audio_agent/realtime/service.py tests/test_realtime_session.py tests/test_realtime_service.py
git commit -m "feat: gate project changes on host confirmation"
```

---

### Task 6: Configuration, Assembly, Prompt, and Trusted CLI

**Files:**
- Modify: `src/nova_audio_agent/config.py`
- Modify: `src/nova_audio_agent/assembly.py`
- Modify: `src/nova_audio_agent/cli.py`
- Modify: `src/nova_audio_agent/realtime/qwen.py`
- Modify: `tests/test_cli.py`
- Modify: `tests/test_assembly.py`
- Modify: `tests/test_realtime_qwen.py`

**Interfaces:**
- Adds Settings fields `codex_projects_enabled: bool = False`, `codex_managed_root: Path = Path("~/NovaWorkspaces")`, and `codex_project_state_root: Path = Path("~/.nova-audio-agent")`.
- Adds `Settings.require_codex_projects() -> tuple[Path, Path]` with safe expansion and validation.
- Adds Typer commands `nova-audio-agent workspace list` and `nova-audio-agent workspace register DISPLAY_NAME PATH`.
- Assembly returns the existing `CodexLiveAdapter` when disabled and `ProjectCodexAdapter` plus shared confirmation controller when enabled.
- `tests/test_cli.py` uses its existing Typer `CliRunner` plus a local `make_workspace(tmp_path)` helper; `tests/test_assembly.py` extends its existing callback fixture with `callbacks()` and filters real compiled schemas through `codex_tool_names`.

- [ ] **Step 1: Write failing settings and CLI tests**

```python
def test_project_settings_read_prefixed_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVA_AUDIO_AGENT_CODEX_PROJECTS_ENABLED", "true")
    monkeypatch.setenv("NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT", str(tmp_path / "managed"))
    monkeypatch.setenv("NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT", str(tmp_path / "state"))
    settings = Settings(_env_file=None)
    assert settings.codex_projects_enabled is True
    assert settings.require_codex_projects() == ((tmp_path / "managed").resolve(), (tmp_path / "state").resolve())

def test_workspace_register_and_list_use_trusted_local_path(cli_runner, tmp_path):
    result = cli_runner.invoke(app, ["workspace", "register", "alpha", str(make_workspace(tmp_path))])
    assert result.exit_code == 0
    listed = cli_runner.invoke(app, ["workspace", "list"])
    assert "alpha" in listed.stdout
    assert str(tmp_path) not in listed.stdout
```

- [ ] **Step 2: Run settings/CLI tests and verify RED**

Run: `uv run pytest tests/test_cli.py -q`

Expected: settings and workspace commands are absent.

- [ ] **Step 3: Implement safe settings and CLI commands**

CLI uses the same `CodexProjectStore`; registration requires an existing non-symlink directory and exact display name validation. Errors print only stable public codes/names, never configured canonical paths from stored state.

- [ ] **Step 4: Run CLI tests and verify GREEN**

Run: `uv run pytest tests/test_cli.py -q`

Expected: all CLI tests pass.

- [ ] **Step 5: Write failing assembly and provider-surface tests**

```python
def test_project_realtime_assembly_imports_workspace_and_exposes_exact_codex_tools(settings):
    settings.codex_projects_enabled = True
    realtime = build_qwen_realtime_assembly(settings, **callbacks())
    assert isinstance(realtime.codex_live_adapter, ProjectCodexAdapter)
    names = codex_tool_names(realtime.tools)
    assert names == ["codex__run", "codex__project", "codex__steer", "codex__status"]
```

Assert disabled mode retains old manifest and ephemeral transport; enabled mode restores persisted active workspace, builds per-workspace transport homes, shares the same controller with RealtimeService, and tears it down on stop.

- [ ] **Step 6: Implement assembly wiring and prompt distinction**

Teach Qwen only: new independent work uses `codex__run`; list/create/select/session continuation uses `codex__project`; project mutations are proposals and it must speak the host-returned concrete confirmation target. Do not add a second coordinator or additional project tools.

- [ ] **Step 7: Run assembly/prompt tests and commit**

Run: `uv run pytest tests/test_assembly.py tests/test_realtime_qwen.py tests/test_cli.py -q`

Then:

```bash
git add src/nova_audio_agent/config.py src/nova_audio_agent/assembly.py src/nova_audio_agent/cli.py src/nova_audio_agent/realtime/qwen.py tests/test_cli.py tests/test_assembly.py tests/test_realtime_qwen.py
git commit -m "feat: wire codex projects into realtime startup"
```

---

### Task 7: Ambient Orb Public Project Projection

**Files:**
- Modify: `src/nova_audio_agent/realtime/desktop.py`
- Modify: `tests/test_realtime_desktop.py`
- Modify: `desktop/ambient-orb/src/renderer/state.mjs`
- Modify: `desktop/ambient-orb/src/renderer/index.mjs`
- Modify: `desktop/ambient-orb/test/state.test.mjs`
- Modify: `desktop/ambient-orb/test/renderer-caption.test.mjs`

**Interfaces:**
- Adds backend message `codex.project` with exactly `workspace_display_name`, `session_title`, and `pending_confirmation`.
- Adds `DesktopSocketBridge.on_codex_project(view)` and a latest-value queue like existing `codex.state`.
- Adds renderer axes `workspace`, `session`, and `pendingConfirmation` and includes them only in the visible Codex label/ARIA label.

- [ ] **Step 1: Write failing backend projection tests**

```python
def test_codex_project_message_has_closed_public_shape():
    assert json.loads(codex_project_message(PublicProjectView("alpha", "Task 1", True))) == {
        "type": "codex.project",
        "workspace_display_name": "alpha",
        "session_title": "Task 1",
        "pending_confirmation": True,
    }
```

Reject control characters, overlong labels, unexpected dataclass types, paths, and private IDs. Assert initial projection is sent after authentication and latest-value updates coalesce.

- [ ] **Step 2: Run desktop tests and verify RED**

Run: `uv run pytest tests/test_realtime_desktop.py -q`

Expected: project message/bridge methods are absent.

- [ ] **Step 3: Implement backend public message and queue**

Keep Codex process state and project view as independent latest-value queues. Release/authentication reset both delivery cursors without deleting the service's current view.

- [ ] **Step 4: Run desktop tests and verify GREEN**

Run: `uv run pytest tests/test_realtime_desktop.py -q`

Expected: desktop protocol tests pass.

- [ ] **Step 5: Write failing renderer state tests**

```javascript
test('shows workspace session and pending confirmation without private metadata', () => {
  const state = deriveOrbState({ ...base, workspace: 'alpha', session: 'Task 1', pendingConfirmation: true })
  assert.equal(state.codexLabel, 'alpha · Task 1 · 等待确认')
})
```

Also assert idle/running labels retain workspace context and malformed `codex.project` messages do not mutate renderer state.

- [ ] **Step 6: Implement renderer message handling and labels**

Accept only the closed backend shape, cap visible text, and render through `textContent`. Do not add registry details, paths, IDs, or HTML insertion.

- [ ] **Step 7: Run Orb tests and commit**

Run: `(cd desktop/ambient-orb && npm test)`

Then:

```bash
git add src/nova_audio_agent/realtime/desktop.py tests/test_realtime_desktop.py desktop/ambient-orb/src/renderer/state.mjs desktop/ambient-orb/src/renderer/index.mjs desktop/ambient-orb/test/state.test.mjs desktop/ambient-orb/test/renderer-caption.test.mjs
git commit -m "feat: show active codex project in ambient orb"
```

---

### Task 8: End-to-End Restart, Isolation, and Redaction Coverage

**Files:**
- Create: `tests/test_e2e_codex_projects.py`
- Create: `src/nova_audio_agent/evals/codex_projects.py`
- Create: `scripts/eval_codex_projects.py`
- Create: `tests/test_eval_codex_projects.py`
- Modify: `tests/repository_scan.py`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `README.zh-CN.md`

**Interfaces:**
- Exercises the real registry, project adapter, Runtime, fake app-server process boundary, RealtimeService confirmation path, and desktop public projection together.
- Documents enablement, managed root, state root, voice commands, Session semantics, one-task limitation, and trusted CLI registration.
- `tests/test_e2e_codex_projects.py` defines a `ProjectHarness` around real store/adapter/Runtime objects and a complete fake app-server peer; `project_harness(tmp_path)` returns that harness, while its result records expose literal `thread_id` and `process_id` captured below the public projection boundary.
- `src/nova_audio_agent/evals/codex_projects.py` defines a fixed corpus and scores provider tool selection only; filesystem/history authorization remains host-side and is never part of the model score.

- [ ] **Step 1: Write failing restart and cross-workspace isolation scenarios**

```python
@pytest.mark.asyncio
async def test_confirmed_session_resume_survives_process_and_orb_restart(tmp_path):
    first = await project_harness(tmp_path).run_new("alpha", "Task 1", "create marker")
    restarted = project_harness(tmp_path)
    resumed = await restarted.confirm_resume("alpha", "Task 1", "continue from marker")
    assert resumed.thread_id == first.thread_id
    assert resumed.process_id != first.process_id

@pytest.mark.asyncio
async def test_workspace_b_cannot_resume_workspace_a_thread(tmp_path):
    harness = project_harness(tmp_path)
    thread_a = await harness.run_new("alpha", "Task 1", "work")
    await harness.create_workspace("beta")
    assert await harness.try_private_cross_binding("beta", thread_a.thread_id) == "session_workspace_mismatch"
```

Add scenarios for zero mutation before confirmation, voice create direct-child safety, busy confirmed resume with no selection mutation, normal runs producing distinct thread IDs, failed resume no fallback, active workspace/Session restart restore, immutable running binding after selection, and no private values in provider outputs/Memory/trace/captions/Orb.

- [ ] **Step 2: Run end-to-end tests and verify RED**

Run: `uv run pytest tests/test_e2e_codex_projects.py -q`

Expected: at least one integration contract fails until all wiring is complete.

- [ ] **Step 3: Fix only integration gaps exposed by the scenarios**

Changes remain in the owning files from Tasks 1-7. For every defect, first split out a focused failing regression test in that component's test file, then make the minimal production correction and rerun both focused and end-to-end tests.

- [ ] **Step 4: Update operator documentation and repository safety scan**

Document exact environment variables and CLI examples without real local paths. Extend the repository scan's sensitive-field allow/deny cases to reject `canonical_path`, `workspace_id`, `session_id`, `codex_thread_id`, `codex_home_key`, and proposal nonce in provider/renderer payload builders.

- [ ] **Step 5: Write and run the deterministic Qwen tool-selection evaluator tests**

The corpus contains literal cases for ordinary new work, workspace list, create with and without initial work, select, Session list, explicit continuation, ambiguous names, negation, and unrelated speech. The scorer accepts only the intended `codex__run`/`codex__project` action or no Codex call and reports per-case mismatches without executing a project mutation.

Run: `uv run pytest tests/test_eval_codex_projects.py -q`

Expected: deterministic scorer and corpus-shape tests pass. The live script remains explicitly invoked and skips without realtime credentials.

- [ ] **Step 6: Run integration and documentation-adjacent tests**

Run: `uv run pytest tests/test_e2e_codex_projects.py tests/test_project_files.py tests/test_start_ambient_orb_macos.py -q`

Expected: all pass.

- [ ] **Step 7: Commit integration, eval, and docs**

```bash
git add tests/test_e2e_codex_projects.py src/nova_audio_agent/evals/codex_projects.py scripts/eval_codex_projects.py tests/test_eval_codex_projects.py tests/repository_scan.py .env.example README.md README.zh-CN.md
git commit -m "test: cover persistent codex project isolation"
```

---

### Task 9: Full Verification and Review-Ready Cleanup

**Files:**
- Modify only files implicated by a failing verification, always after adding or identifying a focused regression test.

**Interfaces:**
- Produces a clean feature branch whose implementation matches the approved design and whose commits remain reviewable by subsystem.

- [ ] **Step 1: Run Python formatting and static checks**

Run:

```bash
uv run ruff format src tests scripts
uv run ruff check src tests scripts
uv run ruff format --check src tests scripts
```

Expected: no diagnostics.

- [ ] **Step 2: Run the complete Python suite**

Run: `NOVA_AUDIO_AGENT_TEST_TIME_BUDGET=7.5 uv run pytest -q`

Expected: all tests pass with no warnings or leaked tasks.

- [ ] **Step 3: Run Electron tests and build**

Run:

```bash
(cd desktop/ambient-orb && npm test)
(cd desktop/ambient-orb && npm run build)
```

Expected: all Node tests pass and the app build succeeds.

- [ ] **Step 4: Build and smoke the Python package**

Run:

```bash
uv build
uv run nova-audio-agent --help
uv run nova-audio-agent workspace --help
```

Expected: build succeeds and both help commands exit zero.

- [ ] **Step 5: Audit diff, sensitive projections, and worktree cleanliness**

Run:

```bash
git diff --check main...HEAD
git status --short
git log --oneline --decorate main..HEAD
```

Inspect every occurrence from:

```bash
rg -n "canonical_path|workspace_id|session_id|codex_thread_id|codex_home_key|nonce" src/nova_audio_agent/realtime src/nova_audio_agent/tool_schema.py desktop/ambient-orb
```

Expected: private fields occur only in host-internal domain/control code and tests; no unstaged source changes remain.
