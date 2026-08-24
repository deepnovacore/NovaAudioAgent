# Always-On Codex Project Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make realtime Codex permanently project-scoped, remove model-visible `codex__run`, and replace phrase-based project confirmation with a turn-bound `codex__confirm_project_action({proposal_id, confirmed})` function call.

**Architecture:** Keep the existing workspace registry, Session/thread persistence, filesystem revalidation, and private Codex run transport. Replace the realtime public contract with one `codex__project` action API plus a host-handled confirmation function; the realtime service binds the function call to the exact reserved user item and only then grants the existing one-shot commit capability. Publish a replaceable active workspace/Session context while leaving historical catalogs behind bounded list actions.

**Tech Stack:** TypeScript 5.9, Node.js 22, Zod, Node test runner, Python 3.11+, Pydantic Settings, pytest, Qwen Audio Realtime protocol, Electron desktop client.

**Spec:** `docs/superpowers/specs/2026-08-24-always-on-codex-project-mode-design.md`

## Global Constraints

- Realtime provider schemas expose `codex__project`, `codex__confirm_project_action`, `codex__steer`, and `codex__status`; they never expose `codex__run`.
- Ordinary non-realtime adapters may retain their existing internal/public `run` contract.
- `start_session` operates only in the current active workspace and does not require confirmation.
- `create_workspace`, `select_workspace`, and `resume_session` require a host-generated proposal and function-call confirmation.
- Confirmation accepts only an exact live `proposal_id`, a JSON boolean, and a tool call bound to the reserved user item in the current provider epoch.
- Model speech and ASR transcript text never authorize a project commit.
- A confirmed operation retains object-identity, one-shot commit authority.
- Full workspace and Session history is never proactively injected; list results remain capped at 20 most-recently-used records.
- Active workspace and Session display names are injected as replaceable host state.
- Existing `codex-projects-v1.json`, workspace directories, Session IDs, and Codex homes remain compatible.
- Managed and state roots keep their approved `~/.nova-audio-agent/...` defaults and expand `~` against the actual home directory.
- TypeScript and Python behavior remain aligned.
- Preserve all pre-existing unrelated working-tree changes; stage only files changed by this plan.

## File Structure

- `runtime/src/codex-contract.ts` and `src/nova_audio_agent/executors/codex_project_live.py`: public project and confirmation schemas.
- `runtime/src/executors/codex-project-live.ts` and the Python mirror: workspace/Session actions and private confirmed execution.
- `runtime/src/realtime/project-confirmation.ts` and the Python mirror: proposal identity, item reservation, boolean decision, expiry, and commit authority.
- `runtime/src/realtime/service.ts` and the Python mirror: confirmation-tool binding, provider output, commit, and ordinary-tool blocking.
- `runtime/src/realtime/qwen.ts`, `src/nova_audio_agent/realtime/qwen.py`, and `runtime/src/realtime-assembly.ts`: semantic routing plus replaceable active-project context.
- Config, host, factory, assembly, environment-contract, fixture, and documentation files: unconditional project composition and removal of the enable toggle.
- `runtime/test/*.test.ts` and `tests/test_*.py`: contract, adapter, confirmation, realtime, context, configuration, assembly, evaluation, and integration coverage.

---

### Task 1: Replace the realtime project tool contract

**Files:**
- Modify: `runtime/src/codex-contract.ts`
- Modify: `runtime/test/codex-contract.test.ts`
- Modify: `src/nova_audio_agent/executors/codex_project_live.py`
- Modify: `tests/test_codex_project_live.py`

**Interfaces:**
- Produces: project manifests with ops `project`, `confirm_project_action`, `steer`, `status`.
- Produces: actions `list_workspaces | create_workspace | select_workspace | list_sessions | start_session | resume_session`.
- Produces: confirmation params `{proposal_id: string; confirmed: boolean}`.
- Consumes: unchanged ordinary/live `RUN`, `STATUS`, and `STEER` contracts.

- [ ] **Step 1: Write failing TypeScript public-name and confirmation-schema tests**

```ts
const compiled = compileToolSchema([CODEX_PROJECT_MANIFEST])
assert.deepEqual([...compiled.bindings.keys()], [
  'codex__project',
  'codex__confirm_project_action',
  'codex__steer',
  'codex__status',
])
assert.equal(compiled.bindings.has('codex__run'), false)
assert.deepEqual(validateCodexRequest('project', 'confirm_project_action', {
  proposal_id: 'proposal-1',
  confirmed: true,
}), {ok: true, value: {proposal_id: 'proposal-1', confirmed: true}})
assert.equal(validateCodexRequest('project', 'confirm_project_action', {
  proposal_id: 'proposal-1',
  confirmed: 'true',
}).ok, false)
```

- [ ] **Step 2: Add table-driven action validation tests**

```ts
const accepted = [
  {action: 'list_workspaces'},
  {action: 'list_sessions'},
  {action: 'list_sessions', workspace: 'alpha'},
  {action: 'create_workspace', workspace: 'alpha'},
  {action: 'create_workspace', workspace: 'alpha', session: 'Initial', work_order: 'build it'},
  {action: 'select_workspace', workspace: 'alpha'},
  {action: 'start_session', session: 'Fix login', work_order: 'fix login'},
  {action: 'resume_session', work_order: 'continue'},
  {action: 'resume_session', workspace: 'alpha', session: 'Fix login', work_order: 'continue'},
] as const
for (const request of accepted) {
  assert.equal(validateCodexRequest('project', 'project', request).ok, true)
}
assert.equal(validateCodexRequest('project', 'project', {
  action: 'start_session', workspace: 'alpha', work_order: 'x',
}).ok, false)
assert.equal(validateCodexRequest('project', 'project', {
  action: 'create_workspace', workspace: 'alpha', session: 'Initial',
}).ok, false)
assert.equal(validateCodexRequest('project', 'run', {work_order: 'x'}).ok, false)
```

- [ ] **Step 3: Run the TypeScript contract test and verify failure**

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/codex-contract.test.js
```

Expected: failure because the project manifest still exposes `codex__run` and the new actions/function are unknown.

- [ ] **Step 4: Implement the TypeScript schema and validator**

```ts
const CONFIRM_PROJECT_ACTION: OpSpec = {
  name: 'confirm_project_action',
  description: '根据用户当前自然语言回答确认或取消正在等待的项目操作',
  params: {
    type: 'object',
    properties: {
      proposal_id: {type: 'string', minLength: 1, maxLength: 128},
      confirmed: {type: 'boolean'},
    },
    required: ['proposal_id', 'confirmed'],
    additionalProperties: false,
  },
  readonly: false,
  confirm: false,
  deadline_budget: 10,
  verifies: [],
  sensitive_params: [],
  sync_result: true,
}

export const CODEX_PROJECT_MANIFEST = manifest([
  PROJECT,
  CONFIRM_PROJECT_ACTION,
  STEER,
  STATUS,
])
```

Set `PROJECT.deadline_budget` to 600 because `start_session` and privately confirmed operations run under that op. Keep `RUN` only in base/live manifests. Validate exact keys per the spec table.

- [ ] **Step 5: Mirror schema and validation in Python**

```python
names = [
    item["function"]["name"]
    for item in compile_tool_schema((CODEX_PROJECT_LIVE_MANIFEST,)).schemas
]
assert names == [
    "codex__project",
    "codex__confirm_project_action",
    "codex__steer",
    "codex__status",
]
assert _normalize_project_request({
    "action": "start_session",
    "work_order": "fix login",
}) == {"action": "start_session", "work_order": "fix login"}
```

Define `CONFIRM_PROJECT_ACTION = OpSpec(...)` with the same JSON schema and deadlines as TypeScript.

- [ ] **Step 6: Run focused contract tests**

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/codex-contract.test.js
uv run pytest tests/test_codex_project_live.py -q
```

Expected: both pass.

- [ ] **Step 7: Commit the contract change**

```bash
git add runtime/src/codex-contract.ts runtime/test/codex-contract.test.ts src/nova_audio_agent/executors/codex_project_live.py tests/test_codex_project_live.py
git commit -m "refactor: unify realtime Codex project tools"
```

### Task 2: Route workspace and Session actions through `codex__project`

**Files:**
- Modify: `runtime/src/executors/codex-project-live.ts`
- Modify: `runtime/test/executors-codex-project-live.test.ts`
- Modify: `src/nova_audio_agent/executors/codex_project_live.py`
- Modify: `tests/test_codex_project_live.py`
- Modify: `tests/test_e2e_codex_projects.py`

**Interfaces:**
- Consumes: Task 1 public actions.
- Produces: `start_session` in the active workspace, proposal IDs for create/select/resume, and private `execute_confirmed` execution.
- Preserves: one run slot, thread-ID verification, workspace revalidation, status, steer, and progress lifecycle.

- [ ] **Step 1: Write failing list/start tests**

```ts
const listed = await adapter.dispatch('project', {action: 'list_workspaces'}, context())
assert.equal(listed.content.code, 'listed')

const started = await adapter.dispatch('project', {
  action: 'start_session',
  session: 'Login fix',
  work_order: 'Fix login and run tests',
}, context())
assert.equal(started.outcome, 'ok')
assert.equal((await store.listSessions(active))[0]?.display_title, 'Login fix')
```

Assert that public `dispatch('run', ...)` is rejected and both list actions remain capped at 20 MRU records.

- [ ] **Step 2: Write failing proposal tests**

```ts
const create = await adapter.dispatch('project', {
  action: 'create_workspace',
  workspace: 'tetris',
  session: 'Initial build',
  work_order: 'Build a complete Tetris game and verify it',
}, context())
assert.equal(create.content.code, 'confirmation_required')
assert.equal(typeof create.content.proposal_id, 'string')
assert.equal(create.content.action, 'create_workspace')
```

Add equivalent assertions for `select_workspace` and `resume_session`, including resolved workspace and Session display names.

- [ ] **Step 3: Run adapter tests and verify failure**

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/executors-codex-project-live.test.js
uv run pytest tests/test_codex_project_live.py tests/test_e2e_codex_projects.py -q
```

Expected: failures on old action names, missing proposal IDs, and absent `start_session` dispatch.

- [ ] **Step 4: Implement TypeScript public and private dispatch**

```ts
const confirmed = consumeHostExecutorCapability(context)
if (confirmed !== null) {
  if (op !== 'project' || request.action !== 'execute_confirmed') {
    return failureHandoff('invalid_operation', op)
  }
  return await this.#runConfirmed(confirmed.operation, context)
}
const admitted = validateCodexRequest('project', op, request)
if (!admitted.ok) return failureHandoff(admitted.error, admitted.op)
if (op === 'project' && admitted.value.action === 'start_session') {
  return await this.#runDefault(
    typeof admitted.value.session === 'string' ? admitted.value.session : null,
    String(admitted.value.work_order),
    context,
  )
}
```

Map old branches to the six new names. Include `proposal_id`, `expires_at`, action, workspace, Session, and prompt in `confirmation_required`. Persist create-with-work's optional Session title.

- [ ] **Step 5: Dispatch confirmed work through private `project`**

```ts
const admission = runtimeDispatch(
  {
    executor: 'codex',
    op: 'project',
    request: {action: 'execute_confirmed'},
    origin_ref: originRef,
  },
  reason,
  operation,
)
```

The public validator rejects `execute_confirmed`; only the host capability reaches it.

- [ ] **Step 6: Mirror dispatch in Python**

```python
if private_operation is not None:
    if op != "project" or request != {"action": "execute_confirmed"}:
        return _failure("invalid_operation", op)
    return await self._run_confirmed(private_operation, ctx)
if op == "project" and normalized["action"] == "start_session":
    return await self._run_default(
        normalized.get("session"),
        normalized["work_order"],
        ctx,
    )
```

- [ ] **Step 7: Run adapter tests**

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/executors-codex-project-live.test.js
uv run pytest tests/test_codex_project_live.py tests/test_e2e_codex_projects.py -q
```

Expected: all pass.

- [ ] **Step 8: Commit project action execution**

```bash
git add runtime/src/executors/codex-project-live.ts runtime/test/executors-codex-project-live.test.ts src/nova_audio_agent/executors/codex_project_live.py tests/test_codex_project_live.py tests/test_e2e_codex_projects.py
git commit -m "refactor: route Codex work through project actions"
```

### Task 3: Replace phrase classification with a boolean decision state machine

**Files:**
- Modify: `runtime/src/realtime/project-confirmation.ts`
- Modify: `runtime/test/realtime-project-confirmation.test.ts`
- Modify: `src/nova_audio_agent/realtime/project_confirmation.py`
- Modify: `tests/test_project_confirmation.py`

**Interfaces:**
- Produces: `ProjectProposal.proposal_id`.
- Produces: `acceptDecision({epoch, itemId, proposalId, confirmed})` and Python `accept_decision(...)`.
- Produces: `releaseUndecided({epoch, itemId})` and Python `release_undecided(...)`.
- Preserves: reservation, 90-second expiry, invalidation, expiry observers, and identity-based `claimConfirmed`.
- Removes: phrase constants, transcript normalization, and transcript classification.

- [ ] **Step 1: Write failing TypeScript decision tests**

```ts
const proposal = controller.prepare(createInput())
assert.equal(controller.reserveUserItem({epoch: 1, itemId: 'user-1'}), true)
const accepted = controller.acceptDecision({
  epoch: 1,
  itemId: 'user-1',
  proposalId: proposal.proposal_id,
  confirmed: true,
})
assert.equal(accepted.kind, 'confirmed')
assert.ok(accepted.operation)
assert.equal(controller.claimConfirmed(accepted.operation), true)
assert.equal(controller.claimConfirmed(accepted.operation), false)
```

Add tests proving false cancels, wrong ID does not commit, wrong epoch/item is ignored, non-boolean is invalid, expiry rejects, duplicate decisions cannot commit, `releaseUndecided` clears only the reservation, and reconnect invalidation clears proposal plus authority.

- [ ] **Step 2: Run confirmation tests and verify failure**

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/realtime-project-confirmation.test.js
uv run pytest tests/test_project_confirmation.py -q
```

Expected: the controllers expose transcript classification rather than structured decisions.

- [ ] **Step 3: Implement the TypeScript decision API**

```ts
acceptDecision(input: {
  readonly epoch: number
  readonly itemId: string
  readonly proposalId: string
  readonly confirmed: boolean
}): ConfirmationOutcome {
  const proposal = this.#proposal
  if (proposal === null || !this.#isReserved(input.epoch, input.itemId)) return outcome('ignored')
  if (this.#isExpired(proposal)) return this.#expireOutcome()
  if (input.proposalId !== proposal.proposal_id || typeof input.confirmed !== 'boolean') {
    return outcome('invalid', {responseText: '确认请求无效，操作尚未执行。'})
  }
  if (!input.confirmed) {
    this.#clearAll()
    this.#publish()
    return outcome('cancelled', {responseText: '已取消。'})
  }
  const operation = confirmedFrom(proposal)
  this.#proposal = null
  this.#reserved = null
  this.#commitAuthority = operation
  this.#publish()
  return outcome('confirmed', {operation})
}

releaseUndecided(input: {readonly epoch: number; readonly itemId: string}): boolean {
  if (this.#proposal === null || !this.#isReserved(input.epoch, input.itemId)) return false
  this.#reserved = null
  return true
}
```

Generate `proposal_id` with `idFactory`, include it in the confirmed operation, and remove imports used only by Unicode phrase normalization.

- [ ] **Step 4: Implement the Python mirror**

```python
def accept_decision(
    self,
    *,
    epoch: int,
    item_id: str,
    proposal_id: str,
    confirmed: bool,
) -> ConfirmationOutcome:
    proposal = self._proposal
    if proposal is None or not self._is_reserved(epoch, item_id):
        return _outcome("ignored")
    if proposal_id != proposal.proposal_id or type(confirmed) is not bool:
        return _outcome("invalid", response_text="确认请求无效，操作尚未执行。")
    if confirmed is False:
        self._clear_all()
        self._publish()
        return _outcome("cancelled", response_text="已取消。")
    operation = _confirmed_from(proposal)
    self._proposal = None
    self._reserved = None
    self._commit_authority = operation
    self._publish()
    return _outcome("confirmed", operation=operation)
```

Delete `_classify_confirmation`, positive/negative sets, filler lists, and their normalization imports.

- [ ] **Step 5: Run confirmation tests**

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/realtime-project-confirmation.test.js
uv run pytest tests/test_project_confirmation.py -q
```

Expected: all pass.

- [ ] **Step 6: Commit the controller change**

```bash
git add runtime/src/realtime/project-confirmation.ts runtime/test/realtime-project-confirmation.test.ts src/nova_audio_agent/realtime/project_confirmation.py tests/test_project_confirmation.py
git commit -m "refactor: use structured project confirmation decisions"
```

### Task 4: Handle the confirmation function in the realtime host

**Files:**
- Modify: `runtime/src/realtime/service.ts`
- Modify: `runtime/test/realtime-service.test.ts`
- Modify: `src/nova_audio_agent/realtime/service.py`
- Modify: `tests/test_realtime_service.py`
- Modify: `runtime/src/realtime/session-fixtures.ts`
- Modify: `tests/test_realtime_protocol.py`

**Interfaces:**
- Consumes: dedicated tool name, controller `acceptDecision`, and commit callback.
- Produces: one host-handled terminal tool output per confirmation call.
- Produces: confirmation-turn policy allowing only the dedicated function.
- Produces: response-terminal release of an undecided reservation.
- Preserves: transcript persistence, provider epoch/item/response correlation, expiry cleanup, reconnect invalidation, and tool-call idempotency.

- [ ] **Step 1: Add a positive function-call integration test**

Create a proposal, emit `user_speech_started(user-1)`, `response_started(response-1)`, and `user_transcript_final(user-1, "好，创建吧")`, then:

```ts
await service.handleEvent(toolCallReady({
  callId: 'confirm-1',
  itemId: 'function-1',
  responseId: 'response-1',
  name: 'codex__confirm_project_action',
  arguments: {proposal_id: proposal.proposal_id, confirmed: true},
}))
assert.equal(commits.length, 1)
assert.equal(commits[0], proposal.proposal_id)
assert.match(session.injectedToolOutputs.at(-1)?.content ?? '', /"code":"confirmed"/)
```

- [ ] **Step 2: Add fail-closed cases**

Pin these exact cases: `confirmed:false` cancels; string `"true"` never commits; stale proposal ID never commits; call replay commits once and yields one provider result per call ID; another response/epoch never commits; expiry never commits; transcript failure never commits; ordinary tools remain blocked; and a response with no confirmation call releases the reservation for the next user item.

- [ ] **Step 3: Run service tests and verify failure**

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/realtime-service.test.js
uv run pytest tests/test_realtime_service.py -q
```

Expected: current code blocks the confirmation function and commits from transcript phrase matching.

- [ ] **Step 4: Permit only the confirmation function through the fence**

```ts
const isConfirmationDecision = event.kind === 'tool_call_ready'
  && event.name === 'codex__confirm_project_action'
const blockedConfirmationTool = event.kind === 'tool_call_ready'
  && this.#blocksProjectConfirmationTool(event)
  && !isConfirmationDecision
```

A confirmation function outside a pending reserved turn receives `confirmation_not_pending` and never reaches the causal runtime.

- [ ] **Step 5: Bind and resolve the function without reading transcript semantics**

```ts
interface BoundToolOrigin {
  readonly observedProviderResponseId: string | null
  readonly originItemId: string | null
  readonly originRef: string | null
}
```

When the tool name matches, call:

```ts
await this.#handleProjectConfirmationDecision(event, {
  epoch: event.session_epoch,
  itemId: origin.originItemId,
  originRef: origin.originRef,
  proposalId: event.arguments.proposal_id,
  confirmed: event.arguments.confirmed,
})
```

The handler validates exact types, calls `acceptDecision`, invokes the commit callback only for a confirmed operation, closes other deferred calls for that item, injects one compact tool output, and queues the existing accepted/cancelled/failure host fact.

- [ ] **Step 6: Release unclear turns at response terminal**

```ts
const itemId = this.#responseUserOriginItems.get(
  callKey(event.session_epoch, event.response_id),
)
if (itemId !== undefined && this.#isProjectConfirmationItem(event.session_epoch, itemId)) {
  this.#projectConfirmation?.releaseUndecided({epoch: event.session_epoch, itemId})
  this.#endProjectConfirmationItem(event.session_epoch, itemId)
}
```

Do not generate a fixed retry phrase; the model's clarification speech is sufficient.

- [ ] **Step 7: Mirror the host integration in Python**

Use `type(value) is bool`, the same epoch/item/response checks, the same sole allowed tool name, and one idempotent provider output per call ID. Transcript-final handling persists origin evidence and releases bound calls; it does not classify the text.

- [ ] **Step 8: Run focused realtime tests**

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/realtime-service.test.js
uv run pytest tests/test_realtime_service.py tests/test_realtime_protocol.py -q
```

Expected: all pass.

- [ ] **Step 9: Commit realtime integration**

```bash
git add runtime/src/realtime/service.ts runtime/test/realtime-service.test.ts runtime/src/realtime/session-fixtures.ts src/nova_audio_agent/realtime/service.py tests/test_realtime_service.py tests/test_realtime_protocol.py
git commit -m "feat: confirm project actions with a realtime function"
```

### Task 5: Inject active project context and teach semantic routing

**Files:**
- Modify: `runtime/src/realtime/qwen.ts`
- Modify: `runtime/src/realtime-assembly.ts`
- Modify: `runtime/src/qwen-realtime-assembly.ts`
- Modify: `runtime/test/realtime-qwen-normalization.test.ts`
- Modify: `runtime/test/realtime-assembly.test.ts`
- Modify: `runtime/test/qwen-realtime-assembly.test.ts`
- Modify: `src/nova_audio_agent/realtime/qwen.py`
- Modify: `tests/test_realtime_qwen.py`
- Modify: `src/nova_audio_agent/evals/codex_projects.py`
- Modify: `tests/test_eval_codex_projects.py`

**Interfaces:**
- Produces: replaceable `<active_project_context>` with current display names.
- Produces: separately tagged optional workspace-graph content.
- Produces: Qwen instructions for six actions and the confirmation function.
- Produces: routing corpus for independent creation, current start, historical list/select/resume.

- [ ] **Step 1: Write failing active-context tests**

```ts
assert.equal(renderActiveProjectContext({
  workspace_display_name: 'alpha',
  session_title: 'Login fix',
  pending_confirmation: false,
}), [
  '<active_project_context>',
  'workspace=alpha',
  'session=Login fix',
  '</active_project_context>',
].join('\n'))
```

Assert that a second view replaces the first provider item, no historical array is present, and graph content is enclosed in `<workspace_graph_context>`.

- [ ] **Step 2: Write failing Qwen instruction tests**

```ts
assert.match(FRONTEND_INSTRUCTIONS, /codex__confirm_project_action/)
assert.match(FRONTEND_INSTRUCTIONS, /list_workspaces.*list_sessions/s)
assert.match(FRONTEND_INSTRUCTIONS, /独立.*create_workspace/s)
assert.match(FRONTEND_INSTRUCTIONS, /当前.*start_session/s)
assert.doesNotMatch(FRONTEND_INSTRUCTIONS, /调用 codex__run/)
assert.doesNotMatch(FRONTEND_INSTRUCTIONS, /确认语音由 host 判定/)
```

- [ ] **Step 3: Write failing routing evaluation cases**

```python
ProjectRoutingCase("independent", "创建一个完整的俄罗斯方块游戏", "codex__project", "create_workspace"),
ProjectRoutingCase("current", "在当前项目里修复登录 bug", "codex__project", "start_session"),
ProjectRoutingCase("history", "继续俄罗斯方块项目", "codex__project", "list_workspaces"),
ProjectRoutingCase("sessions", "列出 alpha 的历史 Session", "codex__project", "list_sessions"),
ProjectRoutingCase("select", "切换到 alpha", "codex__project", "select_workspace"),
ProjectRoutingCase("resume", "继续 alpha 里的 Login fix", "codex__project", "resume_session"),
```

- [ ] **Step 4: Run focused tests and verify failure**

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/realtime-qwen-normalization.test.js runtime/dist/test/realtime-assembly.test.js runtime/dist/test/qwen-realtime-assembly.test.js
uv run pytest tests/test_realtime_qwen.py tests/test_eval_codex_projects.py -q
```

Expected: old instructions reference `codex__run`, and no active-project context exists.

- [ ] **Step 5: Replace Qwen project instructions**

Use these exact behavioral clauses in both runtimes:

```text
Codex 开发工作只使用 codex__project，不得调用 codex__run。
明显独立的完整产品或仓库使用 create_workspace；明确在当前项目内的新任务使用 start_session。
提到以前、上次或命名项目时先 list_workspaces；需要继续历史工作时再 list_sessions，不得猜测候选。
create_workspace、select_workspace、resume_session 返回待确认 proposal，不代表已经执行。
当前存在待确认 proposal 时，根据用户自然语言语义调用 codex__confirm_project_action，复制 proposal_id，并用 confirmed 的 JSON boolean 表示同意或拒绝；语义不明确时不要调用并自然追问。
```

- [ ] **Step 6: Publish active context through the replaceable provider path**

Cache the latest project view and use an assembly-local monotonic revision. On initialization and each view change, serialize:

```ts
const content = [
  renderActiveProjectContext(view),
  graphHeader === null
    ? null
    : `<workspace_graph_context>\n${graphHeader}\n</workspace_graph_context>`,
].filter((part): part is string => part !== null).join('\n')
```

Use the active committed `workspace_id` as `workspace_instance_id`. Update Qwen's preamble so active-project context is authoritative host state while graph context remains low authority and cannot authorize switching.

- [ ] **Step 7: Update the routing evaluator**

Set `ExpectedTool` to `Literal['codex__project', 'codex__confirm_project_action', 'none']`, validate all six actions, and grade confirmation by structured `proposal_id` plus boolean rather than spoken keywords.

- [ ] **Step 8: Run context, prompt, and evaluation tests**

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/realtime-qwen-normalization.test.js runtime/dist/test/realtime-assembly.test.js runtime/dist/test/qwen-realtime-assembly.test.js
uv run pytest tests/test_realtime_qwen.py tests/test_eval_codex_projects.py -q
```

Expected: all pass.

- [ ] **Step 9: Commit context and routing**

```bash
git add runtime/src/realtime/qwen.ts runtime/src/realtime-assembly.ts runtime/src/qwen-realtime-assembly.ts runtime/test/realtime-qwen-normalization.test.ts runtime/test/realtime-assembly.test.ts runtime/test/qwen-realtime-assembly.test.ts src/nova_audio_agent/realtime/qwen.py tests/test_realtime_qwen.py src/nova_audio_agent/evals/codex_projects.py tests/test_eval_codex_projects.py
git commit -m "feat: publish active Codex project context"
```

### Task 6: Make realtime project mode unconditional

**Files:**
- Modify: `.env`
- Modify: `.env.example`
- Modify: `runtime/src/config.ts`
- Modify: `runtime/src/environment-contract.ts`
- Modify: `runtime/src/codex-host-config.ts`
- Modify: `runtime/src/codex-production-host.ts`
- Modify: `runtime/src/codex-factory.ts`
- Modify: `runtime/src/qwen-realtime-assembly.ts`
- Modify: `runtime/src/cascaded-realtime-assembly.ts`
- Modify: relevant TypeScript config/host/factory/assembly tests
- Modify: `src/nova_audio_agent/config.py`
- Modify: `src/nova_audio_agent/assembly.py`
- Modify: `tests/test_config.py`
- Modify: `tests/test_cli.py`
- Modify: `tests/test_assembly.py`
- Modify: `fixtures/config/v1/expected.json`

**Interfaces:**
- Removes: `codex_projects_enabled` and `NOVA_AUDIO_AGENT_CODEX_PROJECTS_ENABLED`.
- Produces: project roots and a project resource for every realtime Codex composition.
- Preserves: ordinary non-realtime composition and approved tilde/directory handling.

- [ ] **Step 1: Write failing toggle-removal tests**

```ts
const settings = loadSettings({})
assert.equal(Object.hasOwn(settings, 'codex_projects_enabled'), false)
assert.equal(settings.codex_managed_root, '~/.nova-audio-agent/workspaces')
assert.equal(settings.codex_project_state_root, '~/.nova-audio-agent')
```

```python
settings = Settings(_env_file=None)
assert not hasattr(settings, "codex_projects_enabled")
assert settings.codex_managed_root == Path("~/.nova-audio-agent/workspaces")
assert settings.codex_project_state_root == Path("~/.nova-audio-agent")
```

- [ ] **Step 2: Write failing unconditional-composition tests**

```ts
const resource = await createCodexAssemblyResource({
  config, composition: 'realtime', transportFactory, projectHost, clock, idFactory,
})
assert.equal(resource.mode, 'project')
assert.equal(compileToolSchema([resource.adapter.manifest]).bindings.has('codex__run'), false)
```

Assert missing packaged project-native support fails with `codex_project_host_unsupported` rather than returning a live resource.

- [ ] **Step 3: Run focused tests and verify failure**

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/config.test.js runtime/dist/test/codex-host-config.test.js runtime/dist/test/codex-production-host.test.js runtime/dist/test/codex-factory.test.js runtime/dist/test/qwen-realtime-assembly.test.js
uv run pytest tests/test_config.py tests/test_cli.py tests/test_assembly.py -q
```

Expected: tests fail while the toggle and fallback branches remain.

- [ ] **Step 4: Remove TypeScript toggle and fallback branches**

Delete the setting from schema, environment parsing, environment contract, resolved host config, and fixtures. Resolve project roots whenever Codex is selected and load the native project host for usable realtime Codex.

```ts
if (options.composition === 'realtime') {
  return await createProjectResource(options)
}
return createOrdinaryResource(options)
```

Require `codexResource.mode === 'project'` in both realtime assemblies.

- [ ] **Step 5: Remove the Python toggle and live fallback**

```python
if context.codex_live:
    managed_root, state_root = context.settings.require_codex_projects()
    return _build_project_codex(
        workspace=workspace,
        binary=binary,
        codex_api_key=codex_api_key,
        managed_root=managed_root,
        state_root=state_root,
        context=context,
    )
return CodexAdapter(CodexTransport(binary=binary, workspace=workspace, api_key=codex_api_key))
```

Keep `Path.expanduser().resolve()` for workspace and roots.

- [ ] **Step 6: Remove the environment variable and regenerate fixtures**

Delete the variable from `.env`, `.env.example`, environment contract rows, and bilingual generated docs. Regenerate/check fixtures with:

```bash
npm run fixtures:schema
npm run check:env-contract
```

- [ ] **Step 7: Run focused configuration tests**

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/config.test.js runtime/dist/test/config-fixture.test.js runtime/dist/test/codex-host-config.test.js runtime/dist/test/codex-production-host.test.js runtime/dist/test/codex-factory.test.js runtime/dist/test/qwen-realtime-assembly.test.js
uv run pytest tests/test_config.py tests/test_cli.py tests/test_assembly.py -q
npm run check:env-contract
```

Expected: all pass.

- [ ] **Step 8: Commit unconditional composition**

```bash
git add .env.example runtime/src/config.ts runtime/src/environment-contract.ts runtime/src/codex-host-config.ts runtime/src/codex-production-host.ts runtime/src/codex-factory.ts runtime/src/qwen-realtime-assembly.ts runtime/src/cascaded-realtime-assembly.ts runtime/test src/nova_audio_agent/config.py src/nova_audio_agent/assembly.py tests/test_config.py tests/test_cli.py tests/test_assembly.py fixtures/config/v1/expected.json
git commit -m "refactor: make realtime Codex project mode mandatory"
```

Do not stage `.env`; it is local runtime configuration.

### Task 7: Document, verify, and restart the client

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/getting-started.md`
- Modify: `docs/getting-started.zh-CN.md`
- Modify: `docs/multi-project-workspace-handoff.md`
- Modify: `runtime/test/codex-assembly-integration.test.ts`
- Modify: `tests/test_e2e_codex_projects.py`
- Modify: project-mode golden fixtures that still name old public actions.

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces: end-to-end proof, updated user docs, and a restarted desktop client.

- [ ] **Step 1: Add provider-schema integration coverage**

```ts
const names = provider.connectedTools.map(tool => tool.function.name)
assert.deepEqual(names.filter(name => name.startsWith('codex__')), [
  'codex__project',
  'codex__confirm_project_action',
  'codex__steer',
  'codex__status',
])
assert.equal(names.includes('codex__run'), false)
```

- [ ] **Step 2: Add create-and-confirm e2e coverage**

Use a temporary managed root and deterministic IDs; propose `create_workspace`, bind a user turn, emit a true confirmation function, then assert:

```python
snapshot = store.snapshot()
created = next(item for item in snapshot.workspaces if item.display_name == "tetris")
assert created.origin == "managed"
assert Path(created.canonical_path).parent == managed_root.resolve()
assert snapshot.active_workspace_id == created.workspace_id
assert any(item.workspace_id == created.workspace_id for item in snapshot.sessions)
```

- [ ] **Step 3: Run integration tests**

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/codex-assembly-integration.test.js
uv run pytest tests/test_e2e_codex_projects.py -q
```

Expected: pass.

- [ ] **Step 4: Update English and Chinese docs**

Document these exact facts:

```text
Workspace = one filesystem/Git project.
Session = one restorable Codex thread inside that workspace.
Managed workspaces = ~/.nova-audio-agent/workspaces.
Project registry = ~/.nova-audio-agent/codex-projects-v1.json.
Per-workspace Codex homes = ~/.nova-audio-agent/codex-homes.
Realtime project mode is always enabled.
Historical projects and Sessions are queried on demand.
Creation, switching, and resume use natural-language function confirmation.
```

Remove every instruction to set the deleted enable variable.

- [ ] **Step 5: Run full TypeScript verification**

```bash
npm run typecheck --workspace @nova-audio-agent/runtime
npm run lint --workspace @nova-audio-agent/runtime
npm run test:runtime
npm run check:env-contract
npm run check:node-parity
```

Expected: all exit 0.

- [ ] **Step 6: Run full Python verification**

```bash
uv run ruff check src tests
uv run pytest -q
```

Expected: all exit 0.

- [ ] **Step 7: Search for stale production references**

```bash
rg -n "NOVA_AUDIO_AGENT_CODEX_PROJECTS_ENABLED|新的独立开发需求调用 codex__run|确认语音由 host 判定|classifyConfirmation|classify_confirmation" runtime/src src/nova_audio_agent README.md README.zh-CN.md docs .env.example
```

Expected: no matches outside historical design documents that explicitly describe removed behavior.

- [ ] **Step 8: Commit docs and integration coverage**

```bash
git add README.md README.zh-CN.md docs/getting-started.md docs/getting-started.zh-CN.md docs/multi-project-workspace-handoff.md runtime/test/codex-assembly-integration.test.ts tests/test_e2e_codex_projects.py
git commit -m "docs: explain always-on Codex projects"
```

- [ ] **Step 9: Restart only the Nova desktop client**

Identify the existing Nova process from `scripts/start-client.mjs`, terminate only that process tree, then start:

```bash
npm run start:client
```

Verify the replacement process remains alive and its startup log contains no configuration, project-host, or provider-schema error. Do not terminate unrelated Electron, Node, Codex, or Python processes.

## Self-Review Record

- Spec coverage: every approved requirement maps to Tasks 1-7; state compatibility requires no migration task.
- Placeholder scan: no deferred implementation markers remain; behavior-changing steps include exact interfaces, assertions, or branch structure.
- Type consistency: action names, `proposal_id`, `confirmed`, decision/release methods, and private `execute_confirmed` are consistent across tasks.
- Scope check: contract, adapter, confirmation, context, configuration, and docs form one provider protocol change; splitting them would leave intermediate realtime builds with an unusable public tool or confirmation function.
