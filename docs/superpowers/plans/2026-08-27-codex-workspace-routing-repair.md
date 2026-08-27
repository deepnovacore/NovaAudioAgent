# Codex Workspace Routing Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex project routing generic, reject malformed project calls before dispatch, recover same-name workspaces without a false failure, and prevent failed delegates from speaking stale startup acknowledgements.

**Architecture:** A shared Codex project contract becomes the only action-specific request authority in each runtime. Realtime acknowledgements remain keyed by `background:<delegate_id>` and gain terminal fencing before speech. Workspace creation resolves existing names into current-workspace reuse or a host-owned reuse proposal, while the common event vocabulary gains the pre-effect `refused` outcome.

**Tech Stack:** Python 3.11+, pytest, TypeScript, Node.js 22+, node:test, Zod, Nova Runtime/Memory fixtures.

**Spec:** `docs/archs/2026-08-27-codex-workspace-routing-admission-lifecycle.md`

## Global Constraints

- Never overwrite, delete, or silently rename an existing Workspace.
- Do not create a suffixed Workspace unless the user explicitly asks for a separate copy.
- Cross-Workspace reuse must use the existing proposal ID, 360-second TTL, reservation, and one-time commit authority.
- `start_session` remains valid only for the active Workspace and must reject a `workspace` field.
- A bridge refusal creates no delegate, no dispatch, no semantic acknowledgement, and no Codex terminal Memory item.
- `started/working`, not protocol receipt, owns “Codex 已开始处理” language.
- Keep Python and TypeScript behavior byte/fixture compatible where parity is part of the existing contract.
- Preserve all unrelated dirty-worktree files.

---

### Task 1: Incorporate Review Corrections Into the Spec

**Files:**
- Modify: `docs/archs/2026-08-27-codex-workspace-routing-admission-lifecycle.md`
- Create: `docs/superpowers/plans/2026-08-27-codex-workspace-routing-repair.md`

**Interfaces:**
- Consumes: reviewer findings in the user-provided review text.
- Produces: an implementation contract that explicitly covers the stale `validParams` comment, current-workspace reuse speech, model pre-tool self-narration, and acknowledgement association through `background:<delegate_id>`.

- [ ] **Step 1: Correct evidence line references and document the stale validator assumption**

  Change the unique-name guard references to Python `785-788` and TypeScript `2245-2248`. Record that the `validParams` “all used schema shapes” comment became false when `PROJECT.oneOf` landed.

- [ ] **Step 2: Specify both acknowledgement owners**

  State that host acknowledgement fencing uses the existing `background:<delegate_id>` key without adding a redundant `delegate_id` field. Separately require prompt/eval coverage for model text streamed before a tool result.

- [ ] **Step 3: Specify reuse presentation**

  Require current-workspace reuse to say “复用现有工作区” and forbid “已创建工作区”.

- [ ] **Step 4: Verify and commit the documentation**

  Run:

  ```bash
  git diff --check
  rg -n 'T[B]D|T[O]DO|FIXM[E]|X[X]X' docs/archs/2026-08-27-codex-workspace-routing-admission-lifecycle.md docs/superpowers/plans/2026-08-27-codex-workspace-routing-repair.md
  ```

  Expected: `git diff --check` exits 0 and the placeholder scan has no matches.

  Commit:

  ```bash
  git add docs/archs/2026-08-27-codex-workspace-routing-admission-lifecycle.md
  git add -f docs/superpowers/plans/2026-08-27-codex-workspace-routing-repair.md
  git commit -m "docs(codex): incorporate workspace routing review"
  ```

### Task 2: Align the 360-Second Confirmation TTL Across Desktop Boundaries

**Files:**
- Modify: `src/nova_audio_agent/realtime/project_confirmation.py`
- Modify: `src/nova_audio_agent/realtime/desktop.py`
- Modify: `tests/test_realtime_desktop.py`
- Modify: `runtime/src/realtime/project-confirmation.ts`
- Modify: `runtime/src/desktop-wire.ts`
- Modify: `runtime/test/desktop-wire.test.ts`
- Modify: `desktop/ambient-orb/src/renderer/index.mjs`
- Modify: `desktop/ambient-orb/test/renderer-caption.test.mjs`

**Interfaces:**
- Consumes: `ProjectConfirmationView.pending_expires_in_seconds` in the inclusive range `0..360`.
- Produces: identical Python encoder, TypeScript wire, and renderer acceptance for the controller's 360-second TTL.

- [ ] **Step 1: Write failing Python and TypeScript wire tests**

  Encode a pending create view with `pending_expires_in_seconds=360` and assert a valid `codex.project` frame. Add a renderer source-contract assertion that its accepted upper bound is 360, matching the wire fixture.

- [ ] **Step 2: Run the tests and verify RED**

  ```bash
  PYTHONPATH=src pytest tests/test_realtime_desktop.py -q
  npm run build --workspace @nova-audio-agent/runtime
  node --test runtime/dist/test/desktop-wire.test.js
  node --test desktop/ambient-orb/test/renderer-caption.test.mjs
  ```

  Expected: the 360-second cases fail because all three consumers still cap the value at 90.

- [ ] **Step 3: Export and consume the TTL contract**

  Rename the controller constants to public `PROJECT_CONFIRMATION_TTL_SECONDS = 360` / `PROJECT_CONFIRMATION_TTL_SECONDS = 360` in TypeScript and import them in the Python encoder and TypeScript wire. Set the renderer's independently deployed protocol cap to the same literal and pin it with its test.

- [ ] **Step 4: Re-run the tests and verify GREEN**

  Re-run Step 2. Expected: all pass; `360.001` remains invalid at the wire boundary.

- [ ] **Step 5: Commit TTL parity**

  ```bash
  git add src/nova_audio_agent/realtime/project_confirmation.py src/nova_audio_agent/realtime/desktop.py tests/test_realtime_desktop.py runtime/src/realtime/project-confirmation.ts runtime/src/desktop-wire.ts runtime/test/desktop-wire.test.ts desktop/ambient-orb/src/renderer/index.mjs desktop/ambient-orb/test/renderer-caption.test.mjs
  git commit -m "fix(desktop): accept the extended confirmation ttl"
  ```

### Task 3: Make Project Admission Use One Shared Contract

**Files:**
- Create: `src/nova_audio_agent/executors/codex_project_contract.py`
- Modify: `src/nova_audio_agent/executors/codex_project_live.py`
- Modify: `src/nova_audio_agent/realtime/bridge.py`
- Modify: `tests/test_codex_project_live.py`
- Modify: `tests/test_realtime_bridge.py`
- Modify: `runtime/src/realtime/bridge.ts`
- Modify: `runtime/test/realtime-bridge.test.ts`
- Modify: `runtime/test/codex-contract.test.ts`

**Interfaces:**
- Consumes: provider arguments after `origin_ref` is removed.
- Produces: Python `normalize_project_request(request: object) -> dict[str, str] | None`; TypeScript reuses `validateCodexRequest('project', 'project', request)`.

- [ ] **Step 1: Write failing Python bridge admission test**

  Add a production-manifest adapter to `tests/test_realtime_bridge.py` and assert:

  ```python
  result = await bridge.accept_tool_call(
      ToolCallReady(
          session_epoch=1,
          call_id="call-project-invalid",
          item_id="item-project-invalid",
          name="codex__project",
          arguments={
              "action": "start_session",
              "workspace": "tetris-game",
              "work_order": "写一个计时器",
              "origin_ref": "conversation:1",
          },
      )
  )
  assert result.accepted is False
  assert result.code == "invalid_params"
  assert runtime.delegates.snapshot() == ()
  ```

- [ ] **Step 2: Run the Python test and verify RED**

  Run:

  ```bash
  PYTHONPATH=src pytest tests/test_realtime_bridge.py::test_project_action_fields_are_refused_before_dispatch -q
  ```

  Expected: FAIL because the current bridge accepts and dispatches the malformed request.

- [ ] **Step 3: Write failing TypeScript bridge admission test**

  Extend `project-boundary actions wait for their result while task execution stays delegated` with a malformed `start_session + workspace` call and assert `accepted === false`, `code === 'invalid_params'`, and no extra `dispatchExternal` call.

- [ ] **Step 4: Run the TypeScript test and verify RED**

  Run:

  ```bash
  npm run build --workspace @nova-audio-agent/runtime
  node --test runtime/dist/test/realtime-bridge.test.js --test-name-pattern="project-boundary"
  ```

  Expected: FAIL because `validParams` ignores `oneOf`.

- [ ] **Step 5: Extract the Python project contract**

  Move `_PROJECT_FIELDS`, `_project_variant`, `PROJECT`, and `_normalize_project_request` into `codex_project_contract.py`. Export:

  ```python
  PROJECT: OpSpec

  def normalize_project_request(request: object) -> dict[str, str] | None:
      ...
  ```

  Re-export `_normalize_project_request = normalize_project_request` from `codex_project_live.py` for current import compatibility while changing the adapter itself to call the public contract function.

- [ ] **Step 6: Admit through the shared contract in both bridges**

  In Python, before generic `_valid_params`:

  ```python
  if binding.executor == "codex" and binding.op == "project":
      normalized = normalize_project_request(arguments)
      if normalized is None:
          return self._refused(call, "invalid_params")
      arguments = normalized
  elif op is None or not _valid_params(arguments, op.params):
      return self._refused(call, "invalid_params")
  ```

  In TypeScript, use `validateCodexRequest('project', 'project', arguments_)`; dispatch `validation.value` only when `ok` is true. Make generic `validParams` return false when it sees `oneOf`, and replace its obsolete comment with a simple-schema-only contract.

- [ ] **Step 7: Run focused admission and contract tests and verify GREEN**

  Run:

  ```bash
  PYTHONPATH=src pytest tests/test_realtime_bridge.py tests/test_codex_project_live.py -q
  npm run build --workspace @nova-audio-agent/runtime
  node --test runtime/dist/test/realtime-bridge.test.js runtime/dist/test/codex-contract.test.js
  ```

  Expected: all pass; malformed action fields never dispatch.

- [ ] **Step 8: Commit shared admission**

  ```bash
  git add src/nova_audio_agent/executors/codex_project_contract.py src/nova_audio_agent/executors/codex_project_live.py src/nova_audio_agent/realtime/bridge.py tests/test_codex_project_live.py tests/test_realtime_bridge.py runtime/src/realtime/bridge.ts runtime/test/realtime-bridge.test.ts runtime/test/codex-contract.test.ts
  git commit -m "fix(realtime): reject invalid project calls before dispatch"
  ```

### Task 4: Fence Undelivered Acknowledgements on Terminal Failure

**Files:**
- Modify: `src/nova_audio_agent/realtime/session.py`
- Modify: `src/nova_audio_agent/realtime/service.py`
- Modify: `tests/test_realtime_service.py`
- Modify: `runtime/src/realtime/service-state.ts`
- Modify: `runtime/src/realtime/service.ts`
- Modify: `runtime/test/realtime-service.test.ts`

**Interfaces:**
- Consumes: terminal `HandoffEvent.delegate_id` / TypeScript handoff payload delegate ID.
- Produces: `_fence_semantic_acknowledgement(delegate_id: str) -> bool` and `#fenceSemanticAcknowledgement(delegateId: string): boolean`; both use `background:<delegate_id>`.

- [ ] **Step 1: Write failing queued-ack terminal tests in Python and TypeScript**

  Arrange one accepted async Codex delegate whose acknowledgement is pending or queued, project an immediate failed Handoff for the same delegate, and assert:

  ```text
  semantic acknowledgement no longer deliverable
  no queued/injected host item has event_id background:d-1
  final:d-1 remains queued exactly once
  delegate state is failed
  ```

  Name the tests `test_failed_handoff_fences_undelivered_semantic_acknowledgement` in both runtimes.

- [ ] **Step 2: Run both tests and verify RED**

  Run:

  ```bash
  PYTHONPATH=src pytest tests/test_realtime_service.py::test_failed_handoff_fences_undelivered_semantic_acknowledgement -q
  npm run build --workspace @nova-audio-agent/runtime
  node --test runtime/dist/test/realtime-service.test.js --test-name-pattern="failed handoff fences"
  ```

  Expected: FAIL because the acknowledgement survives the Handoff.

- [ ] **Step 3: Add response suppression parity for bound-but-unspoken acknowledgements**

  Add Python `RealtimeSession.suppress_response(response_id: str) -> bool` with the same boundary as TypeScript `suppressResponse`: return false after speech or after a playback generation exists; otherwise add the response ID to `_suppressed_response_ids`.

  Extend acknowledgement phase with `cancelled`. The fence function:

  ```text
  pending/queued  -> remove queued host fact and acknowledgement
  requested       -> mark cancelled until ResponseStarted identifies the response
  bound unspoken  -> suppress response, then remove acknowledgement
  delivered/spoken -> keep delivery proof; terminal failure is a later truthful fact
  ```

- [ ] **Step 4: Implement delegate-keyed fencing before final projection**

  At the start of a non-`ok` Handoff branch, call the fence function before queuing `final:<delegate_id>`. When a response starts, suppress a response carrying a cancelled acknowledgement event before normal acknowledgement binding.

- [ ] **Step 5: Add bound-unspoken and already-spoken tests**

  Verify a bound response with no playback is suppressed, while an acknowledgement with a real delivery proof remains `delivered` and is followed by one failure fact rather than being retroactively erased.

- [ ] **Step 6: Run focused lifecycle tests and verify GREEN**

  Run:

  ```bash
  PYTHONPATH=src pytest tests/test_realtime_service.py -q
  npm run build --workspace @nova-audio-agent/runtime
  node --test runtime/dist/test/realtime-service.test.js
  ```

  Expected: all realtime service tests pass.

- [ ] **Step 7: Commit acknowledgement fencing**

  ```bash
  git add src/nova_audio_agent/realtime/session.py src/nova_audio_agent/realtime/service.py tests/test_realtime_service.py runtime/src/realtime/service-state.ts runtime/src/realtime/service.ts runtime/test/realtime-service.test.ts
  git commit -m "fix(realtime): fence stale Codex acknowledgements"
  ```

### Task 5: Replace Example-Specific Routing With Relationship Rules

**Files:**
- Modify: `src/nova_audio_agent/realtime/qwen.py`
- Modify: `runtime/src/realtime/qwen.ts`
- Modify: `src/nova_audio_agent/evals/codex_projects.py`
- Modify: `tests/test_eval_codex_projects.py`
- Modify: `tests/test_realtime_qwen.py`
- Modify: `runtime/test/realtime-qwen-normalization.test.ts`
- Modify: generated normalization fixture only through the repository fixture workflow if its source payload changes.

**Interfaces:**
- Consumes: user utterance plus authoritative active-project context.
- Produces: generic `create_workspace` vs `start_session` routing and no pre-result completion claim.

- [ ] **Step 1: Write failing relationship-driven corpus tests**

  Add cases whose expected actions are hand-written literals:

  ```text
  active=tetris-game + “继续做俄罗斯方块” -> start_session, no workspace field
  active=tetris-game + “写一个计时器应用” -> create_workspace(timer-app)
  active=tetris-game + “给当前俄罗斯方块加计时器” -> start_session
  active=ledger-app + “写一个博客应用” -> create_workspace(blog-app)
  ```

  Add a corpus invariant that at least three unrelated deliverable entities cover the independent/current relationship, so one exemplar cannot define the route.

- [ ] **Step 2: Run routing tests and verify RED**

  Run:

  ```bash
  PYTHONPATH=src pytest tests/test_eval_codex_projects.py tests/test_realtime_qwen.py -q
  ```

  Expected: FAIL because the corpus and prompt tests still pin the Tetris-specific rule.

- [ ] **Step 3: Replace the production rule**

  Remove the Tetris sentence from both prompts. Add generic precedence:

  ```text
  explicit current-project relation -> start_session
  independent deliverable without current relation -> create_workspace
  same identity as active project -> start_session, never duplicate create
  historical named target -> list/resolve before selection
  before tool result -> no “已创建/已提交/正在启动” claim
  ```

- [ ] **Step 4: Update prompt tests and normalization parity**

  Assert the generic relationships and absence of a concrete one-example mapping. Keep Python/TypeScript outbound prompt fixture parity.

- [ ] **Step 5: Run routing and normalization tests and verify GREEN**

  ```bash
  PYTHONPATH=src pytest tests/test_eval_codex_projects.py tests/test_realtime_qwen.py -q
  npm run build --workspace @nova-audio-agent/runtime
  node --test runtime/dist/test/realtime-qwen-normalization.test.js
  ```

  Expected: all pass.

- [ ] **Step 6: Commit generic routing**

  ```bash
  git add src/nova_audio_agent/realtime/qwen.py runtime/src/realtime/qwen.ts src/nova_audio_agent/evals/codex_projects.py tests/test_eval_codex_projects.py tests/test_realtime_qwen.py runtime/test/realtime-qwen-normalization.test.ts fixtures/realtime/qwen/v1
  git commit -m "fix(realtime): generalize Codex workspace routing"
  ```

### Task 6: Resolve Existing Workspace Names Without a Failed Create

**Files:**
- Modify: `src/nova_audio_agent/realtime/project_confirmation.py`
- Modify: `src/nova_audio_agent/executors/codex_project_live.py`
- Modify: `src/nova_audio_agent/executors/codex_projects.py`
- Modify: `tests/test_project_confirmation.py`
- Modify: `tests/test_codex_project_live.py`
- Modify: `tests/test_e2e_codex_projects.py`
- Modify: `runtime/src/realtime/project-confirmation.ts`
- Modify: `runtime/src/executors/codex-project-live.ts`
- Modify: `runtime/src/desktop-wire.ts`
- Modify: `runtime/test/realtime-project-confirmation.test.ts`
- Modify: `runtime/test/executors-codex-project-live.test.ts`
- Modify: `runtime/test/desktop-wire.test.ts`
- Modify: `src/nova_audio_agent/realtime/desktop.py`
- Modify: `tests/test_realtime_desktop.py`

**Interfaces:**
- Consumes: `create_workspace(workspace, work_order)` when the normalized name already exists.
- Produces: current-workspace `workspace_reused` result, or `ProjectAction='reuse'` / public `pending_action='reuse_workspace'` proposal that atomically selects the existing Workspace and starts a new Session after confirmation.

- [ ] **Step 1: Write failing current-workspace reuse tests**

  With `alpha` active, dispatch `create_workspace(alpha, work_order)`. Assert an `ok` structured result with this literal public shape, the existing workspace ID remains the only `alpha`, and no confirmation is pending:

  ```json
  {
    "op": "project",
    "code": "workspace_reused",
    "workspace": "alpha",
    "next_action": "start_session",
    "message": "将复用现有工作区“alpha”，不会创建新工作区。"
  }
  ```

- [ ] **Step 2: Write failing inactive-workspace reuse proposal tests**

  With `beta` active and `alpha` existing, dispatch `create_workspace(alpha, work_order)`. Assert `confirmation_required`, proposal action `reuse`, and prompt:

  ```text
  是否使用现有工作区“alpha”并开始任务？请确认或取消。
  ```

  Confirm once, verify the exact existing workspace is selected and one new Session starts with the original work order. Replay confirmation must not run twice.

- [ ] **Step 3: Run project tests and verify RED**

  ```bash
  PYTHONPATH=src pytest tests/test_project_confirmation.py tests/test_codex_project_live.py tests/test_e2e_codex_projects.py -q
  npm run build --workspace @nova-audio-agent/runtime
  node --test runtime/dist/test/realtime-project-confirmation.test.js runtime/dist/test/executors-codex-project-live.test.js
  ```

  Expected: same-name create still returns `workspace_name_conflict`.

- [ ] **Step 4: Implement exact-name resolution**

  Resolve a same-name record before `validate_managed_create`. If it is active, return `workspace_reused` without claiming creation; the generic route then issues `start_session`. If it is inactive, prepare `action='reuse'` with exact workspace ID and original work order.

  Extend confirmation validation, public pending action, prompt generation, proposal revalidation, and confirmed execution. The confirmed reuse path must select by both display name and immutable ID, refresh project context, then run a new Session with the saved work order.

- [ ] **Step 5: Run project tests and verify GREEN**

  Re-run the commands from Step 3. Expected: all pass; the commit-time uniqueness guard still rejects a concurrent collision.

- [ ] **Step 6: Commit workspace resolution**

  ```bash
  git add src/nova_audio_agent/realtime/project_confirmation.py src/nova_audio_agent/executors/codex_project_live.py src/nova_audio_agent/executors/codex_projects.py tests/test_project_confirmation.py tests/test_codex_project_live.py tests/test_e2e_codex_projects.py runtime/src/realtime/project-confirmation.ts runtime/src/executors/codex-project-live.ts runtime/src/codex-project-store.ts runtime/test/realtime-project-confirmation.test.ts runtime/test/executors-codex-project-live.test.ts
  git commit -m "fix(codex): resolve existing workspace names"
  ```

### Task 7: Add the Pre-Effect `refused` Outcome End to End

**Files:**
- Modify: `src/nova_audio_agent/memory/items.py`
- Modify: Python event/runtime type sites found by `rg "ok.*unknown.*failed|Outcome" src/nova_audio_agent`
- Modify: `runtime/src/events.ts`
- Modify: `runtime/src/causal-runtime.ts`
- Modify: `runtime/src/runtime.ts`
- Modify: `runtime/src/sims.ts`
- Modify: `runtime/src/workspace-graph/models.ts`
- Modify: `runtime/src/workspace-graph/service.ts`
- Modify: `runtime/test/events.test.ts`
- Modify: `runtime/test/memory.test.ts`
- Modify: `runtime/test/runtime.test.ts`
- Modify: `runtime/test/causal-runtime.test.ts`
- Modify: `runtime/test/workspace-graph-contracts.test.ts`
- Modify: `runtime/test/workspace-graph-service.test.ts`
- Modify: `tests/test_memory.py`
- Modify: `tests/test_runtime_loop.py`
- Modify: `src/nova_audio_agent/executors/codex_project_live.py`
- Modify: `runtime/src/executors/codex-project-live.ts`

**Interfaces:**
- Consumes: executor Handoff before target side effects occur.
- Produces: `Outcome = 'ok' | 'refused' | 'unknown' | 'failed'`; `refused` is definitive and terminal but not an execution failure.

- [ ] **Step 1: Write failing event and project refusal tests**

  Parse/append/serialize one `refused` handoff in Python and TypeScript. Assert a residual `workspace_name_conflict` race returns `outcome='refused'` with `recoverable=true`, while `workspace_create_failed` remains `failed`.

- [ ] **Step 2: Run focused tests and verify RED**

  ```bash
  PYTHONPATH=src pytest tests/test_memory.py tests/test_runtime_loop.py tests/test_codex_project_live.py -q
  npm run build --workspace @nova-audio-agent/runtime
  node --test runtime/dist/test/events.test.js runtime/dist/test/memory.test.js runtime/dist/test/executors-codex-project-live.test.js
  ```

  Expected: schema/type rejection for `refused`.

- [ ] **Step 3: Extend the shared outcome vocabulary**

  Add `refused` to the Python literal and TypeScript Zod schema. Treat it as definitive terminal state in runtime dedup/termination maps. Preserve old stored values unchanged; no data rewrite is required because this is an additive reader change.

- [ ] **Step 4: Classify only verified pre-effect project refusals**

  Use an explicit set such as:

  ```text
  workspace_name_conflict
  workspace_not_found
  session_not_found
  session_unavailable
  workspace_name_invalid
  workspace_limit
  session_limit
  ```

  Do not classify storage corruption, permission, boundary-change, write, or process failures as refused. Attach `recoverable=true` only where a corrected user choice can proceed.

- [ ] **Step 5: Regenerate/check fixtures and verify GREEN**

  Run focused Python and TypeScript event, Memory, runtime, workspace-graph, project adapter, and fixture tests. Expected: `refused` round-trips and old `ok|unknown|failed` fixtures still load.

- [ ] **Step 6: Commit outcome semantics**

  ```bash
  git add src/nova_audio_agent runtime/src runtime/test tests fixtures
  git commit -m "feat(runtime): distinguish refused executor outcomes"
  ```

  Before committing, inspect `git diff --cached --name-only` and unstage any unrelated file.

### Task 8: Full Verification and Main-Branch Handoff

**Files:**
- Modify only parity audit or generated expected fixtures whose differences are directly caused by Tasks 2-7.

**Interfaces:**
- Consumes: all preceding commits.
- Produces: verified main branch with no unrelated staged files.

- [ ] **Step 1: Run Python regression suites**

  ```bash
  PYTHONPATH=src pytest tests/test_realtime_bridge.py tests/test_realtime_service.py tests/test_realtime_qwen.py tests/test_eval_codex_projects.py tests/test_project_confirmation.py tests/test_codex_project_live.py tests/test_e2e_codex_projects.py -q
  ```

- [ ] **Step 2: Run Node runtime tests**

  ```bash
  npm run test:runtime
  ```

- [ ] **Step 3: Run repository checks**

  ```bash
  npm run check
  git diff --check
  ```

  If `check:node-parity` reports an intentional audited-source inventory change, inspect the diff and update `runtime/node-parity-audit.json` through the repository audit workflow; do not bypass the check.

- [ ] **Step 4: Verify the original reproductions**

  Confirm:

  ```text
  start_session + workspace -> bridge refusal, zero delegates
  current Tetris + independent timer app -> create_workspace(timer-app)
  terminal invalid/failure before ack -> no later background ack
  same-name current Workspace -> reuse result, no failed item
  same-name inactive Workspace -> one reuse confirmation, one new Session after confirm
  ```

- [ ] **Step 5: Inspect repository state**

  ```bash
  git status --short --branch
  git log --oneline --decorate -8
  ```

  Expected: only the user's pre-existing unrelated untracked files remain; all repair commits are on local `main`.
