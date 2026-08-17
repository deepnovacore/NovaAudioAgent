# Codex Project Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Phase 2 multi-workspace sessions recoverable across malformed inputs, dropped delegates, credential rotation, persistent-state limits, and realtime confirmation cancellation.

**Architecture:** Preserve the four-tool public contract and single Codex run lock. Replace adapter-global confirmation state with a host-private runtime capability, bound the JSON registry, atomically synchronize credential sources, distinguish transient resume failure from invalid history, and close every fenced realtime tool call explicitly.

**Tech Stack:** Python 3.12, asyncio, fcntl, JSON, pytest, Ruff, Electron/Node test runner.

## Global Constraints

- Project mode remains opt-in and exposes exactly `codex__run`, `codex__project`, `codex__steer`, and `codex__status`.
- Only one Codex task may execute at a time.
- Provider data never contains workspace paths, workspace IDs, thread IDs, tokens, credential digests, confirmation nonces, or host-private capabilities.
- Workspace creation, selection, and session resume remain deterministic host-confirmed operations.
- Registry files and credential artifacts remain owner-controlled (`0700` directories, `0600` files), non-symlink, canonical, and atomically replaced.
- All behavior changes follow RED → GREEN → focused regression → commit before the next task.

---

### Task 1: Host-private confirmed-run capability and canonical request parsing

**Files:**
- Modify: `src/nova_audio_agent/ports.py`
- Modify: `src/nova_audio_agent/runtime.py`
- Modify: `src/nova_audio_agent/executors/codex_project_live.py`
- Test: `tests/test_codex_project_live.py`
- Test: `tests/test_context_view.py`
- Test: `tests/test_runtime_loop.py`

**Interfaces:**
- Produces: `DelegateRequest.private: object | None` and `Delegate.private: object | None`, both defaulting to `None`.
- Produces: `_ProjectRunRequest(work_order: str, session_title: str | None, confirmed: ConfirmedProjectOperation | None)`.
- Removes: `ProjectCodexAdapter._armed` and `_commit_reservation`.

- [ ] **Step 1: Write failing tests for whitespace, lifecycle cleanup, and privacy**

```python
@pytest.mark.asyncio
async def test_confirmed_work_order_is_normalized_once_before_runtime_dispatch(tmp_path):
    adapter, operation = confirmed_create(tmp_path, work_order="  host work\n")
    admission = await adapter.commit_confirmed(operation, origin_ref="conversation:1", runtime_dispatch=dispatch)
    result = await adapter.dispatch("run", {"work_order": "host work"}, context_for(admission.delegate_id))
    assert result.outcome == "ok"


@pytest.mark.asyncio
async def test_dropped_confirmed_delegate_cannot_make_later_run_busy(tmp_path):
    adapter, operation = confirmed_create(tmp_path, work_order="first")
    await adapter.commit_confirmed(operation, origin_ref="conversation:1", runtime_dispatch=accepted_but_dropped)
    result = await adapter.dispatch("run", {"work_order": "later"}, context_for("later"))
    assert result.content.get("error") != "busy"


def test_host_private_delegate_capability_is_absent_from_context_and_deadline_evidence():
    capability = object()
    delegate = Delegate(
        delegate_id="private-confirmed",
        executor="codex",
        op="run",
        request={"work_order": "x"},
        origin_ref="conversation:1",
        deadline=600.0,
        routing_class="user_awaited",
        dispatched_at=0.0,
        private=capability,
    )
    memory = Memory(policies=(CODEX_POLICY,))
    view = compile_context_view(memory, floor="idle", now=0.0, in_flight=(delegate,))
    assert "ConfirmedProjectOperation" not in view.in_flight[0].what
    assert "private" not in view.in_flight[0].what
```

In `tests/test_runtime_loop.py`, dispatch the same request through a real `Runtime`, apply
its deadline, and assert the stored `content["request"]` contains only the redacted
`work_order`; the private object must be absent by identity and representation.

- [ ] **Step 2: Run the three tests and verify RED**

Run: `uv run pytest tests/test_codex_project_live.py tests/test_context_view.py tests/test_runtime_loop.py -q -k 'confirmed_work_order_is_normalized_once or dropped_confirmed_delegate or host_private_delegate'`

Expected: whitespace produces `confirmation_binding_mismatch`, the dropped admission leaves later work `busy`, and ports do not accept `private`.

- [ ] **Step 3: Add the host-private runtime field**

```python
@dataclass(frozen=True, slots=True)
class DelegateRequest:
    executor: str
    op: str
    request: dict[str, Any]
    origin_ref: MemoryRef
    private: object | None = None


@dataclass(frozen=True, slots=True)
class Delegate:
    # existing public/runtime fields stay unchanged
    private: object | None = None
```

Set `private=request.private` in `bind_delegate`; do not read it in ContextView, `_deadline_request`, telemetry, rejection evidence, or deduplication.

- [ ] **Step 4: Replace `_armed` with the exact host capability**

Normalize `work_order` before `confirmation.prepare`, pass `private=operation` in the internal `DelegateRequest`, and read `ctx.delegate.private` during `dispatch("run")`. Reject a non-`None` private value unless `type(value) is ConfirmedProjectOperation` and its normalized work order matches. Provider JSON continues to contain only `work_order` and optional `session`.

- [ ] **Step 5: Run focused tests and the executor/runtime regression slice**

Run: `uv run pytest tests/test_codex_project_live.py tests/test_context_view.py tests/test_runtime_loop.py tests/test_delegates.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/nova_audio_agent/ports.py src/nova_audio_agent/runtime.py src/nova_audio_agent/executors/codex_project_live.py tests/test_codex_project_live.py tests/test_context_view.py tests/test_runtime_loop.py
git commit -m "fix: bind confirmed projects without adapter state"
```

### Task 2: Bounded and non-blocking project registry

**Files:**
- Modify: `src/nova_audio_agent/executors/codex_projects.py`
- Test: `tests/test_codex_projects.py`

**Interfaces:**
- Produces: `MAX_WORKSPACES = 100`, `MAX_SESSIONS_PER_WORKSPACE = 200`, `MAX_SESSIONS_TOTAL = 1000`.
- Produces: `rollback_session_start(session_id: str) -> bool`.
- Produces bounded errors: `workspace_limit`, `session_limit`, and `state_busy`.

- [ ] **Step 1: Write failing registry tests**

Start with the default-title assertion:

```python
def test_default_session_titles_are_speakable_workspace_ordinals(tmp_path):
    store = _store(tmp_path)
    workspace = store.ensure_imported("alpha", _workspace(tmp_path, "alpha"))
    first = store.begin_session(workspace.workspace_id, None)
    store.mark_session_ready(first.session_id, "thread-one")
    second = store.begin_session(workspace.workspace_id, None)
    assert (first.display_title, second.display_title) == ("任务 1", "任务 2")
```

Add five separate tests with these exact assertions: importing a second checkout leaves the
first workspace ID active; retention deletes unavailable before inactive ready; starting
and active IDs survive pruning; rollback succeeds only for an unbound starting record;
and contention returns `state_busy`. The contention test holds `LOCK_EX` on a second
descriptor, runs `snapshot()` in a helper thread with `join(0.1)`, and fails RED if that
thread remains alive.

- [ ] **Step 2: Run the new tests and verify RED**

Run: `uv run pytest tests/test_codex_projects.py -q -k 'new_configured_checkout or speakable_workspace_ordinals or retention or rollback_session_start or contended_registry'`

Expected: current code raises `workspace_import_conflict`, generates a Unix timestamp title, grows without pruning, lacks rollback, and blocks on the held lock (run the contention assertion in a helper thread with a bounded join so RED cannot hang pytest).

- [ ] **Step 3: Implement idempotent import and bounded workspace naming**

When a canonical path is unseen, create a registered record even when state is non-empty. Generate `name`, `name (2)`, and subsequent numeric suffixes with `_unique_workspace_name`; retain an existing `active_workspace_id` and set active only when it is `None`. Reject the 101st workspace with `workspace_limit`.

- [ ] **Step 4: Implement speakable titles, retention, and rollback**

Generate `任务 N` by scanning numeric default titles in the same workspace. Before insertion, prune oldest `unavailable`, then oldest inactive `ready`, excluding every active session and every `starting` record. Enforce per-workspace and global limits after pruning. `rollback_session_start` deletes only `state == "starting" and codex_thread_id is None`, repairs the owning workspace's `active_session_id`, and returns `False` for every other state.

- [ ] **Step 5: Make lock contention non-blocking**

Use `fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)` and translate only `EACCES`/`EAGAIN` to `ProjectStateError("state_busy")`; retain the `finally` unlock/close path for acquired descriptors.

- [ ] **Step 6: Run registry tests and verify encoded state stays bounded**

Run: `uv run pytest tests/test_codex_projects.py -q`

Expected: PASS, including an assertion that a maximally retained registry remains below `MAX_STATE_BYTES`.

- [ ] **Step 7: Commit**

```bash
git add src/nova_audio_agent/executors/codex_projects.py tests/test_codex_projects.py
git commit -m "fix: bound and recover codex project state"
```

### Task 3: Atomic credential-source refresh

**Files:**
- Modify: `src/nova_audio_agent/executors/codex_app_server.py`
- Test: `tests/test_codex_app_server.py`

**Interfaces:**
- Produces private marker: `.nova-credential-source-v1.json`, mode `0600`, mapping credential filename to last copied SHA-256 digest.
- Produces helper: `_sync_saved_login(destination_home: Path) -> None`.

- [ ] **Step 1: Write failing credential lifecycle tests**

```python
async def test_persistent_home_refreshes_when_host_login_changes(tmp_path):
    transport, source, destination = persistent_transport(tmp_path, token="first")
    await transport.run("first", on_status=lambda _value: None, on_progress=None)
    source.joinpath("auth.json").write_text('{"token":"second"}')
    replacement = persistent_transport_for_existing_home(tmp_path, destination)
    await replacement.run("second", on_status=lambda _value: None, on_progress=None)
    assert destination.joinpath("auth.json").read_text() == '{"token":"second"}'
```

Add separate tests that mutate only the destination and assert it survives, inspect every
created credential/marker mode as `0600`, and replace source/marker with a symlink or
wrong-owner fixture and assert `credential_missing`. Implement the two named transport
helpers beside the existing `_transport` fixture using `_Peer`, `_Factory`, and
`_ProtocolProbe`; they must return real `CodexAppServerTransport` instances.

- [ ] **Step 2: Run the tests and verify RED**

Run: `uv run pytest tests/test_codex_app_server.py -q -k 'persistent_home_refreshes or destination_refresh or credential_refresh_uses or unsafe_source_or_marker'`

Expected: host rotation is ignored and no source marker exists.

- [ ] **Step 3: Implement secure source reads and atomic destination writes**

Open source files with `O_NOFOLLOW` where available, verify regular file/owner, cap credential and marker sizes, hash bytes, and write temporary files via `os.open(temp, flags, 0o600)`, `os.fchmod`, `fsync`, `os.replace`, and directory `fsync`. Never use `shutil.copyfile` for credentials.

- [ ] **Step 4: Implement digest-marker semantics**

If source digest differs from the marker, replace destination and update the marker. If it matches, validate but preserve destination content. On migration without a marker, adopt identical content; otherwise use a strictly newer source mtime to decide refresh and then write the marker.

- [ ] **Step 5: Run the app-server tests**

Run: `uv run pytest tests/test_codex_app_server.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/nova_audio_agent/executors/codex_app_server.py tests/test_codex_app_server.py
git commit -m "fix: refresh persistent codex credentials safely"
```

### Task 4: Recoverable session startup and bounded assembly failure

**Files:**
- Modify: `src/nova_audio_agent/executors/codex_app_server.py`
- Modify: `src/nova_audio_agent/executors/codex_project_live.py`
- Modify: `src/nova_audio_agent/assembly.py`
- Modify: `src/nova_audio_agent/cli.py`
- Test: `tests/test_codex_app_server.py`
- Test: `tests/test_codex_project_live.py`
- Test: `tests/test_assembly.py`
- Test: `tests/test_cli.py`

**Interfaces:**
- Produces transport code `resume_unavailable` only for rejected/mismatched persistent thread binding.
- Consumes `CodexProjectStore.rollback_session_start` from Task 2.

- [ ] **Step 1: Write failing session-state tests**

```python
@pytest.mark.asyncio
async def test_transient_resume_transport_failure_preserves_ready_session(tmp_path):
    adapter, store, workspace, saved = ready_project_session(tmp_path, title="登录修复")
    adapter._worker_factory = transient_failure_factory("credential_missing")
    result = await dispatch_confirmed_resume(adapter, workspace, saved, "继续检查")
    assert result.outcome == "failed"
    assert store.resolve_session(workspace.workspace_id, saved.display_title).state == "ready"
```

Create `ready_project_session`, `transient_failure_factory`, and
`dispatch_confirmed_resume` as test-only helpers from the existing `_ProjectFactory` and
confirmation setup. Add independent assertions that `resume_unavailable` changes the
record to unavailable, a never-ready new run leaves no session record, and a monkeypatched
`ensure_imported` raising `ProjectStateError("state_corrupt")` becomes a path-free
`ConfigurationError`.

- [ ] **Step 2: Run the tests and verify RED**

Run: `uv run pytest tests/test_codex_app_server.py tests/test_codex_project_live.py tests/test_assembly.py tests/test_cli.py -q -k 'transient_resume or history_rejection or rolls_back_provisional or bounded_configuration'`

Expected: all pre-ready failures mark unavailable, provisional sessions remain, and startup leaks `ProjectStateError`.

- [ ] **Step 3: Classify resume binding failure in the transport**

Wrap `thread/resume` RPC rejection and persistent projection mismatch as `AppServerProtocolError("resume_unavailable")`; preserve `credential_missing`, `spawn_failed`, `adapter_timeout`, cancellation, and generic transport codes unchanged.

- [ ] **Step 4: Apply state transitions in the adapter**

For a new session, roll back if no thread became ready. For a resumed session, preserve `ready` on transient failure and mark unavailable only when the handoff/result code is `resume_unavailable` or the exact ready callback proves a thread/workspace mismatch. Publish the resulting public view after the state transition.

- [ ] **Step 5: Bound project-store construction failures**

Translate `ProjectStateError` during `_build_codex` into `ConfigurationError(f"Codex project state unavailable: {failure.code}")`; ensure chat/demo/desktop entrypoints render or propagate only this bounded message and never a private path.

- [ ] **Step 6: Run focused and surrounding tests**

Run: `uv run pytest tests/test_codex_app_server.py tests/test_codex_project_live.py tests/test_assembly.py tests/test_cli.py tests/test_realtime_desktop.py -q`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/nova_audio_agent/executors/codex_app_server.py src/nova_audio_agent/executors/codex_project_live.py src/nova_audio_agent/assembly.py src/nova_audio_agent/cli.py tests/test_codex_app_server.py tests/test_codex_project_live.py tests/test_assembly.py tests/test_cli.py
git commit -m "fix: recover project sessions from startup failures"
```

### Task 5: Realtime confirmation fence receipts and provider closure

**Files:**
- Modify: `src/nova_audio_agent/realtime/session.py`
- Modify: `src/nova_audio_agent/realtime/service.py`
- Modify: `src/nova_audio_agent/realtime/project_confirmation.py`
- Test: `tests/test_realtime_session.py`
- Test: `tests/test_realtime_service.py`
- Test: `tests/test_project_confirmation.py`

**Interfaces:**
- Produces: `_close_project_confirmation_tool(event: ToolCallReady) -> Awaitable[None]`.
- Produces: `_close_confirmation_deferred_calls(item_id: str) -> Awaitable[None]`.
- Keeps provider output state `{"code":"confirmation_reserved","state":"superseded"}` bounded and non-sensitive.

- [ ] **Step 1: Write failing receipt and protocol tests**

```python
@pytest.mark.asyncio
async def test_reserved_confirmation_fence_emits_receipt_for_pending_host_event():
    actions = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="host-item",
            event_id="confirmation-pending-event",
            content="pending",
        )
    )
    session.arm_next_response_fence()
    assert not await session.accept(ResponseStarted(session_epoch=1, response_id="reserved"))
    receipt = session.take_fence_interruption()
    assert receipt is not None
    assert receipt.event_ids == ("confirmation-pending-event",)
```

Add four service/controller tests using `make_service`: a blocked call ID appears in
`provider.injected` as `tool_output` while `FakeBridge.calls` stays empty; a keyed deferred
call is closed and removed while unrelated entries remain; expiry reconnects epoch 1 to
epoch 2 before a later call is admitted; and `controller.view.pending_confirmation` is
false after the virtual clock reaches `expires_at`.

Assert exact event IDs leave retained suggestion authority, every blocked call ID appears in an injected `tool_output`, no blocked call reaches `FakeBridge.calls`, and the post-expiry tool is accepted only in the new epoch.

- [ ] **Step 2: Run the tests and verify RED**

Run: `uv run pytest tests/test_realtime_session.py tests/test_realtime_service.py tests/test_project_confirmation.py -q -k 'reserved_confirmation_fence_emits or blocked_confirmation_tool_gets or deferred_calls_are_closed or expiry_reconnects_fenced or expired_confirmation_view'`

Expected: receipt is `None`, no tool output exists, deferred entries disappear silently, epoch remains blocked, and expired view reports pending.

- [ ] **Step 3: Pair fence arming with interruption bookkeeping**

In `arm_next_response_fence`, when a pending host response exists and no fence is armed, call `_mark_head_pending_fenced()` before setting `_fence_next_response`. The later `ResponseStarted`/unknown terminal continues to pop exactly once.

- [ ] **Step 4: Close blocked and deferred provider calls**

Build a `HostContextItem.tool_output` for the original `call_id` and inject it through `session.inject_tool_output` immediately, without calling the runtime bridge or requesting a continuation response. Replace `_discard_confirmation_deferred_calls` with an async close operation that preserves unrelated deque entries and closes each matching call exactly once.

- [ ] **Step 5: Recover expiry safely**

When expiry fires with `_project_confirmation_responses` non-empty, schedule one provider reconnect for the current epoch, clear confirmation correlation only as part of reconnect, and queue the expiry fact after the new epoch is active. Normal response terminal still discards its exact `(epoch, response_id)` entry.

- [ ] **Step 6: Make Orb confirmation projection expiry-aware**

Return `pending_confirmation=self.pending` and suppress proposal labels when `pending` is false.

- [ ] **Step 7: Run the realtime regression slice**

Run: `uv run pytest tests/test_realtime_session.py tests/test_realtime_service.py tests/test_project_confirmation.py tests/test_realtime_desktop.py -q`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/nova_audio_agent/realtime/session.py src/nova_audio_agent/realtime/service.py src/nova_audio_agent/realtime/project_confirmation.py tests/test_realtime_session.py tests/test_realtime_service.py tests/test_project_confirmation.py
git commit -m "fix: close project confirmation protocol state"
```

### Task 6: Public UX, proposal validation, and documentation

**Files:**
- Modify: `src/nova_audio_agent/executors/codex_project_live.py`
- Modify: `src/nova_audio_agent/realtime/service.py`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `.env.example`
- Test: `tests/test_codex_project_live.py`
- Test: `tests/test_realtime_service.py`

**Interfaces:**
- Produces stable Chinese user messages for project confirmation commit failures.
- Documents project mode disabling prewarm and bounded session retention.

- [ ] **Step 1: Write failing UX tests**

```python
@pytest.mark.asyncio
async def test_invalid_create_is_rejected_before_confirmation(tmp_path):
    adapter, _store = _adapter(tmp_path)
    result = await adapter.dispatch(
        "project",
        {"action": "create", "workspace": "../etc"},
        _context(VirtualClock()),
    )
    assert result.outcome == "failed"
    assert adapter.confirmation.pending is False
```

Add a service test whose commit callback returns
`ProjectCommitResult(False, "workspace_name_conflict")`; assert the queued spoken fact is
the stable Chinese conflict sentence and does not contain `workspace_name_conflict`.

- [ ] **Step 2: Run the tests and verify RED**

Run: `uv run pytest tests/test_codex_project_live.py tests/test_realtime_service.py -q -k 'invalid_create_is_rejected or bounded_chinese'`

Expected: invalid create enters confirmation and snake_case code is spoken.

- [ ] **Step 3: Add read-only proposal validation and bounded wording**

Validate workspace name/path capacity and name conflicts before proposal creation without mutating state. Map commit result categories to stable Chinese phrases; keep the internal code in trusted structured handoff/telemetry only.

- [ ] **Step 4: Update operator documentation**

Document default-off project mode, startup import behavior, generated session titles, 200-per-workspace/1000-global retention, `state_busy`, credential refresh semantics, and the intentional absence of prewarm in project mode.

- [ ] **Step 5: Run UX/config tests and commit**

Run: `uv run pytest tests/test_codex_project_live.py tests/test_realtime_service.py tests/test_cli.py -q`

```bash
git add src/nova_audio_agent/executors/codex_project_live.py src/nova_audio_agent/realtime/service.py README.md README.zh-CN.md .env.example tests/test_codex_project_live.py tests/test_realtime_service.py
git commit -m "docs: explain recoverable codex project behavior"
```

### Task 7: Full verification and independent review

**Files:**
- Modify only if verification finds a regression; every such change requires a new failing test first.

- [ ] **Step 1: Format and lint**

Run:

```bash
uv run ruff format src tests scripts
uv run ruff check src tests scripts
uv run ruff format --check src tests scripts
```

- [ ] **Step 2: Run the complete Python suite**

Run: `NOVA_AUDIO_AGENT_TEST_TIME_BUDGET=7.5 uv run pytest -q`

Expected: all tests pass within the configured budget.

- [ ] **Step 3: Run Orb tests and build**

Run:

```bash
cd desktop/ambient-orb
npm test
npm run build
```

- [ ] **Step 4: Build distribution and smoke-test CLI**

Run:

```bash
uv build
uv run nova-audio-agent workspace --help
```

- [ ] **Step 5: Audit the complete diff**

Run:

```bash
git diff --check main...HEAD
git status --short
git log --oneline --decorate main..HEAD
```

Expected: no whitespace errors, no generated artifacts staged, and a clean worktree.

- [ ] **Step 6: Request independent review**

Ask the reviewer to explicitly inspect exception catch coverage, mutable-container cleanup, bounded persistent state, credential source changes, sync syscalls on async paths, fence receipts, and provider function-call closure. Fix every Critical/Important through a fresh RED/GREEN cycle.

- [ ] **Step 7: Final verification commit if needed**

Commit only real verification-driven fixes with a scoped message; do not create an empty commit.
