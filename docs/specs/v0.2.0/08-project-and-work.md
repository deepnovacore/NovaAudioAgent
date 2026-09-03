# 08. Project, Session and Work

> 摘要：语音模型不再操作 workspace/session 状态机。今天的 `codex__project` 六个 action 加独立确认工具，换成四个宿主工具：`work__dispatch(objective, project?, session?)`、`work__steer`、`work__status`、`work__cancel`，以及只读 `project__sessions` 和唯一保留 propose-and-confirm 的 `project__create`。FastBrain 工具名里**不再出现任何执行器前缀**。项目清单（roster）作为版本化 `workspace_context` item 常驻 ContextView，模型据此直接选项目；切换既有项目**不确认**（可逆），新建才确认（不可逆）。session 由 `'latest' | 'new' | <session_id>` 表达，宿主永远恢复该项目最近线程。适配器锁从全局单飞改为**每 session 一把**，不同项目可并行；取消的是正在跑的 **work**，session 与历史保留，取消是确认式而非乐观。session 标题由宿主从 objective 生成并经 `thread/name/set` 写回 Codex，Codex 成为标题的单一真相源。里程碑 **M1.5b**，依赖 07。
>
> 对照 qwen-audio-agent 的差异是**有意的**：它把项目选择下沉到后端 coordinator（一个更慢的模型），我们把判断留给已在场的 FastBrain、把记账留给确定性宿主，因为 Surrogate / Floor / 气泡都依赖宿主知道"当前在哪个项目"。

## Baseline (today)

- Voice never calls `codex__run`. Coding work enters through
  `codex__project` with `work_order` (`codex-contract.ts:128–138`):
  `create_workspace | start_session | resume_session` → `#interceptIntake`
  (`service.ts` ~3823) → WorkOrder v2 → either silent
  `dispatchExternal({executor:'codex', op:'project'})` (`start_session`,
  `realtime-assembly.ts:826`) or propose-and-confirm via
  `codex__confirm_project_action`. Management actions
  (`list_workspaces | select_workspace | list_sessions`) bypass intake.
- A typical "改博客" needs `list_workspaces` → `select_workspace` (+confirm)
  → `start_session`: **≥3 tool round-trips** on a realtime model, each an
  audible pause.
- `session` and `workspace` are both model-visible concepts; users never say
  "线程三".
- Store (`codex-project-store.ts`): `WorkspaceRecord{display_name,
  canonical_path, active_session_id, last_used_at}`,
  `ProjectSessionRecord{display_title, codex_thread_id, state, last_used_at}`.
  No summary/preview. Default title `任务 N`
  (`DEFAULT_SESSION_TITLE`, line 57). Title otherwise comes from the model's
  `session` string.
- Codex 0.152.0 `Thread` has `name` ("Optional user-facing thread title"),
  `preview` (first user message), `recencyAt`; methods `thread/name/set`,
  notification `thread/name/updated`. **No** auto-naming in app-server; on this
  machine `name` is set only on VS Code-sourced threads (71/643), never on
  app-server-sourced ones (0). Nova handles neither method.
- Concurrency: Runtime admits any number of delegates (`runtime.ts:1565`
  refuses only identical requests); adapters serialize with `#runActive`
  (`codex-common.ts:190`, `codex-project-live.ts:280`) → second run = `busy`.
- Cancel: `ExecutorDispatchContext.signal` reaches adapters
  (`codex-project-live.ts:283`); transport sends `turn/interrupt`
  (`codex-app-server-transport.ts:1176`); `causal-runtime.ts:447` aborts on
  shutdown/deadline. **No model-facing cancel tool**, no per-delegate abort API.
- `workspace_context` item: produced by
  `RealtimeAssembly.#injectCurrentProjectContext` (`realtime-assembly.ts`
  ~608–678), content `<active_project_context>` + optional
  `<workspace_graph_context>`; revision bumps on content change; Qwen adapter
  delivers via `replace_provider_item` (`qwen.ts:393`); item cannot create a
  response (`protocol.ts:206`). Graph header is low-authority
  (`qwen.ts:253–260`).
- Frontend instructions naming `codex__project` etc.: `qwen.ts:134–250`;
  intake fact text `codex__confirm_project_action`: `intake.ts:293`.

## Goals

1. **One round-trip for the common case.** "改博客的暗色模式" with `blog`
   existing and not active = one `work__dispatch` call, no confirmation, no
   list.
2. **No executor name in the model's tool table.** Assert it.
3. **Session invisible by default.** `latest` / `new` cover normal turns;
   historical resume is one read-only lookup away.
4. **Concurrent projects.** Work in A keeps running while B is dispatched;
   roster shows both; Floor semantics untouched.
5. **Confirmed cancellation of work, not sessions.**
6. **Titles humans can say.** Host-generated from the objective, written to
   Codex, mirrored back; `preview` as fallback; `任务 N` removed.

## Non-goals

- Backend-side project selection (qwen coordinator pattern). Rejected: routing
  by a slow model; host loses "which project" and Surrogate / bubbles / Floor
  starve.
- Voice archive / delete of sessions or workspaces — remains the desktop
  maintenance surface (`managed-workspace-maintenance.ts`).
- Multiple live Orbs; cross-project session merge; changing `plan_readback`
  semantics or the intake question policy from [02](02-intake-and-planning.md).
- Widening approval decisions (still boolean + scope per [01](01-codex-approvals.md)).

## Model-facing tools (host-owned)

All compiled by `tool-schema.ts` as host tools (alongside `update_*`,
`memory__recall`). The coding executor's manifest ops (`run / steer / status /
project`) are **not** compiled into the model tool table when
`roles` includes `coding`; the host routes to them.

| Tool | Kind | Params | Notes |
|---|---|---|---|
| `work__dispatch` | write | `objective` (1–4000), `project?` (1–80, roster name), `session?` = `'latest'` \| `'new'` \| `<session_id>` (default `latest`) | Enters intake exactly as today's `start_session`/`resume_session` with `work_order`; `plan_readback` gate unchanged |
| `work__steer` | write | `work` (see Work reference), `instruction` (1–2000) | Routes to executor `steer` op |
| `work__status` | readonly | `work?` | Routes to executor `status`; default: running work of the active project, else the latest terminal one |
| `work__cancel` | write | `work` | Confirmed cancel (below) |
| `project__sessions` | readonly | `project` | Up to 5 most recent `{session_id, title, last_used_at, running, work_id?}` |
| `project__create` | write | `name` (1–80) | Propose-and-confirm through `host__confirm_project` (from 07) — the only remaining confirmation on this surface |

**Work reference.** `work` accepts a `work_id` **or** a roster project name.
The host resolves a project name to that project's single running work; if
the project has more than one running work the call fails with
`ambiguous_work` listing `work_id`s, and if none with `no_running_work`.

**Resolution errors are structured, never guessed.** `work__dispatch` with a
`project` not in the roster returns `unknown_project` with up to 3
`suggestions` (existing normalized-name matching in the store) and
`hint: 'project__create'`; the model asks the user, it does not create. Two
roster names both matching (post-normalization) returns `ambiguous_project`.

**Switching is a side effect, not an action.** `work__dispatch(project: X)`
with `X ≠ active` sets `X` active (`selectWorkspaceExact`) before intake; no
proposal, because switching is reversible. The `intake` still applies its own
gates to the work order.

**Session semantics.** `latest` resumes `active_session_id` of the project
(or starts the first session if none). `new` starts a fresh thread and makes
it active. `<session_id>` must belong to `project` (else `session_mismatch`)
and becomes active on success. If the resolved session is `running`, dispatch
fails with `busy_session` unless `session: 'new'`; the model may offer
`work__steer` instead.

Removed: `codex__project` (all six actions), `codex__confirm_project_action`,
`codex__steer`, `codex__status`, `codex__confirm_codex_approval` (renamed
`host__confirm_approval` in 07). Frontend instructions in `qwen.ts` and the
intake fact text are rewritten for the new names.

## Roster in ContextView

`#injectCurrentProjectContext` gains a `<projects>` block inside the same
`workspace_context` item (same delivery path, same `replace_provider_item`
semantics):

```
<projects active="blog">
blog · 2h · running work=w-7f3a
pricing-svc · yesterday
nova-audio-agent · 3d · running work=w-91c0
</projects>
```

- At most 10 projects ordered by `last_used_at`; names are `display_name`;
  relative age in the user's language; `running` lists `work_id`s.
- Budget: the whole item stays within the existing 300-token header budget
  (`workspace-graph/context.ts:27–32`); if the roster would exceed it, drop
  oldest non-running entries first, never running ones.
- Revision bumps when: store `active_binding_revision` changes, a project is
  created/renamed, or a work starts/ends (`onActiveWorkChanged` already exists
  in `service.ts`).
- **Authority.** The roster is authoritative for choosing an existing project
  in `work__dispatch` / `work__cancel` / `project__sessions`. The
  `<workspace_graph_context>` header remains low-authority and cannot
  authorize anything (`WORKSPACE_GRAPH_POLICY` wording updated to say the
  roster, not the graph, is the source for project names).
- The item still cannot create a response (`protocol.ts:206`).

## Concurrency

- Adapter lock becomes **per session** (`Map<session_id, run>`), replacing
  `#runActive`. One Codex thread admits one turn at a time (Codex constraint;
  same-turn additions go through `steer`); different threads run in parallel.
- Global cap: `MAX_CONCURRENT_WORK = 3` as a constant with a `ponytail:`
  comment (ceiling: one app-server child per workspace home; upgrade path is a
  settings key once real usage shows the need). Exceeding it → `capacity`
  error naming the running `work_id`s so the model can offer to cancel one.
- Each workspace already has its own `CODEX_HOME`; the transport factory must
  allow one live app-server child per workspace concurrently (today's factory
  assumptions are verified in the checklist).
- Floor is unaffected: each running work is an active-executor channel entry
  at priority 50; two concurrent works do not raise priority.

## Cancellation

- `work__cancel(work)` → host resolves `delegate_id` → new
  `CoreRuntime.cancelDelegate(delegate_id, origin_ref)` → `CausalRuntime`
  aborts that task's controller (the same controller `causal-runtime.ts:447`
  uses on shutdown).
- The adapter observes `signal.aborted`, sends `turn/interrupt`, and returns a
  handoff `{outcome: 'cancelled', trust: 'trusted_system', content: {reason:
  'user_cancelled'}}`. `ExecutorHandoff.outcome` gains `'cancelled'`
  (`events.ts`, `ports.ts`, `causal-runtime.ts`). Alternative considered and
  rejected: overloading `refused` — it would make cancelled work look like a
  policy refusal in memory and speech.
- Public state: `running → cancelling → cancelled | failed`. The tool returns
  `cancelling` immediately; the terminal handoff arrives through the normal
  path and is spoken like any terminal result ("博客那个已经停了").
  `cancelling` that exceeds the op's `deadline_budget` becomes `failed` with
  `cancel_timeout`.
- Session and history survive; `project__sessions` shows the session with
  `running: false`.

## Titles

- On `beginSessionForRun` the host derives `display_title` from the work
  order's objective: first sentence, stripped, ≤ 20 code points, existing
  `uniqueSessionTitle` disambiguation. `DEFAULT_SESSION_TITLE` (`任务 N`) and
  `nextDefaultSessionTitle` are deleted.
- After `onThreadReady`, the adapter calls `thread/name/set {threadId, name}`
  (add to `codex-app-server-schema.ts` outbound). Failure is logged, not
  fatal.
- The transport subscribes to `thread/name/updated {threadId, threadName}`
  (add inbound) and the adapter mirrors a non-null name into the store's
  `display_title` — Codex is the source of truth once a name exists.
- `project__sessions` returns `display_title`; when a thread has no name
  (legacy sessions) the store keeps its existing title.

## Desktop

- `project.state` (renamed in 07) adds `roster: [{name, last_used_at,
  running: [{work_id, title}]}]` and drops `pending_action` values other than
  `create_workspace`.
- The confirmation pill appears only for `project__create` proposals and
  approvals.
- Progress bubbles and the last-result entry key on `work_id` so two
  concurrent works do not overwrite each other's bubble/last-result.

## Implementation touchpoints

| Area | Files |
|---|---|
| Tools | `tool-schema.ts` (host tools, skip coding manifest ops), new `runtime/src/work-tools.ts` (validation + resolution), `realtime/bridge.ts` routing |
| Intake | `realtime/intake.ts` (`isIntakeAction` → dispatch-shaped), `realtime/service.ts` `#interceptIntake`, `realtime-assembly.ts` dispatch by role |
| Store | `project-store.ts` (title derivation, per-session running state, roster query) |
| Roster | `realtime-assembly.ts` `#injectCurrentProjectContext`, `realtime/qwen.ts` render + policy text |
| Concurrency | `executors/codex/adapter-project.ts` per-session lock, transport factory, `MAX_CONCURRENT_WORK` |
| Cancel | `runtime.ts` `cancelDelegate`, `causal-runtime.ts`, `events.ts`/`ports.ts` outcome, adapter abort → `turn/interrupt` |
| Titles | `executors/codex/transport/app-server-schema.ts`, `-transport.ts`, adapter mirror |
| Prompt | `realtime/qwen.ts` FRONTEND_INSTRUCTIONS, `intake.ts:293` |
| Desktop | `desktop-wire.ts`, `desktop-bridge.ts`, renderer `index.mjs` / `confirmation-controls.mjs` / `bubbles.mjs` |
| Tests | `codex-contract` → `work-tools`; `realtime-intake`, `realtime-service`, `realtime-project-confirmation`, `project-store`, `executors-codex-project-live`, `realtime-qwen`, `*-assembly`, `causal-runtime`, `codex-app-server-schema/transport`, desktop `confirmation-controls`, wire tests |

## Verification checklist

Deterministic:

- [ ] Compiled realtime tool table contains no name matching `/^codex__/`
      (assert in `tool-schema.test.ts` and `qwen-realtime-assembly.test.ts`).
- [ ] `work__dispatch`: unknown project → `unknown_project` + suggestions;
      ambiguous → `ambiguous_project`; existing non-active → active switched,
      intake entered, **no** proposal; `session:'new'` → new thread;
      `session:<id>` of another project → `session_mismatch`; running latest
      without `new` → `busy_session`.
- [ ] `project__create` → proposal; confirm/decline/expiry through
      `host__confirm_project` unchanged from today's FSM tests.
- [ ] Roster: ≤10 entries, running never dropped under budget pressure,
      revision bumps on the three triggers only, item cannot create a response.
- [ ] Per-session lock: two dispatches to two projects run concurrently under
      a fake transport; same session → `busy_session`; cap 3 → `capacity`.
- [ ] Cancel: `cancelDelegate` aborts exactly one delegate; adapter sends
      `turn/interrupt` once; handoff `cancelled`; second cancel → `not_running`;
      cancel timeout → `failed/cancel_timeout`; session record survives.
- [ ] Titles: derived title ≤20 code points and unique; `thread/name/set`
      sent after ready; `thread/name/updated` mirrors; `任务 N` code deleted.
- [ ] Prompt goldens updated; intake fact text has no `codex__`.
- [ ] Desktop: `project.state` schema with roster; pill only on create;
      bubbles/last-result keyed by `work_id` under two concurrent works.
- [ ] Full `npm test` green; `check:executor-boundary` still zero violations.

Live (DashScope FastBrain / Qwen realtime, real Codex 0.152.0, macOS headset
first, Windows second). Each row records transcript, tool calls, and Codex
`thread/list` output as evidence in IMPLEMENTATION.md:

- [ ] **Direct dispatch.** With `blog` existing and not active, say
      "改博客的暗色模式". Expect exactly one tool call (`work__dispatch`),
      no confirmation prompt, active project switched, bubble within 3 s.
- [ ] **New session + title.** Say "在博客里重新开一个，把 README 翻译成英文".
      Expect `session:'new'`, a new thread, and `codex` TUI / `thread/list`
      showing a name derived from the objective.
- [ ] **Historical resume.** After two sessions exist, say
      "回到刚才翻译 README 那个，继续". Expect `project__sessions` then
      `work__dispatch(session:<id>)` resuming the correct `codex_thread_id`.
- [ ] **Concurrency.** Start a long task in A, then dispatch B. Expect both
      progressing, roster showing two `running`, and a Guard alert still
      preempting speech mid-progress.
- [ ] **Cancel.** Say "取消博客那个". Expect `cancelling` spoken, app-server
      log showing `turn/interrupt`, terminal "已停" within the op deadline, and
      the session still listed.
- [ ] **Unknown / ambiguous.** Say "改一下 pricing 那个" with both
      `pricing-svc` and `pricing-web` present → the model asks which; say
      "改 foo" with no `foo` → the model offers to create → confirm → created.
- [ ] **Regression.** One `file_change` approval accepted by voice under
      `ask`; one declined via banner; YOLO profile runs a command without a
      prompt.
- [ ] **Latency.** Log tool round-trips per dispatch over 10 utterances;
      median must be 1 (today ≥3).

## Decision-record delta (apply on merge)

| Decision | Chosen boundary | Rejected alternative |
|---|---|---|
| Project selection | FastBrain picks a roster name from ContextView; host does resolution, switching (no confirm), session bookkeeping; only create confirms | Model-driven list/select/start state machine; backend coordinator choosing the project; deterministic name parser in the host |
| Session surface | `latest` / `new` / `<session_id>` with a read-only session lookup; titles derived by host and owned by Codex via `thread/name/set` | Model-authored session titles; `任务 N`; session as a first-class voice concept |
| Cancellation | Cancels running work by delegate; confirmed via `turn/interrupt`; new `cancelled` outcome; session survives | Optimistic cancel; "cancel session"; overloading `refused` |
| Concurrency | Per-session adapter lock, cap 3, Floor unchanged | Global single-flight; unbounded parallel app-server children |
