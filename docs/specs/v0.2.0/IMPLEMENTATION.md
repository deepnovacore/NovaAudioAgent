# v0.2.0 implementation ledger

Branch: `v0.2.0dev`. Contract: [00-overview.md](00-overview.md).
Implement M1 first, keeping package versions unchanged. Use the existing Node/TypeScript
runtime, one-shot confirmation controllers, desktop settings transaction and test harness.

- [x] 01: resolve ask / ask_headless / yolo once; derive process, thread and
  effective-config validation from the same profile. Validate the pinned Codex
  0.152.0 schema and exact per-kind approval results, including denial and expiry.
- [x] 06 (M1): settings v4 migration, env contract, permissions/intake/notification
  controls; preserve safe defaults, encrypted secrets and saved/applied distinction.
- [x] 02: bound intake assessment and WorkOrder compilation, request revisions,
  independent planning/execution gates, existing confirmation and admission paths.
- [x] 05: sanitized executor progress, bounded bubble stack and native bounds
  reservation, persistent last-result access independent of notification mode.
- [x] Integration: runtime and desktop builds/tests run serially; review authorization,
  stale-result rejection, config migration and renderer bounds before completion.

Live macOS/headset and Windows acceptance remains distinct from deterministic tests.

## M1.5 (inserted before M2)

- [x] 07 executor boundary: move Codex under `executors/codex/`, `roles` /
  `display_name` / `approvals` on the manifest, `ApprovalBroker` port, role-based
  routing, `executor.*` / `project.*` wire, fixture executor,
  `check:executor-boundary`. Behaviour identical to M1. Deterministic list green;
  independent review follow-ups landed in `2447010`; live rows share M1's open
  voice/headset items.
- [ ] 08 project/session/work — **implemented 2026-09-04, reviewed, live
  acceptance partial** (coordinator sink). Deterministic coverage is in; the
  coordinator model and the adapter↔Codex path have live evidence below; the
  voice path does not yet.
  - [x] Voice tools `dispatch(executor, instruction)` / `cancel(executor,
    instruction?)` / `confirm(id, accepted)` are single global `host` bindings
    (`work-tools.ts`, `tool-schema.ts`); executors with manifest `agent.summary`
    fold into the `dispatch.executor` enum and lose their `${name}__${op}`
    schemas (bindings stay for host routing). `confirm` selects the FSM by id
    (approval `pending_approval_id` vs project `pending_confirmation_id`).
  - [x] Intake + coordinator live in `runtime/src/executors/coding/`
    (`intake.ts`, `intake-model.ts`, `work-order.ts`); `assess` returns
    `kind / project / project_evidence / session`, gets roster ≤10 + active
    project + running works; non-active project needs `project_evidence`
    verified against the raw utterance, otherwise `unclear`; non-roster names
    are never mapped (`unclear` or explicit `create`); `create` with a goal
    runs clarify → plan → proposal `{action:'create', work_order}`; create-only
    proposes `work_order: null`. **Any change of the active project confirms**
    (decision 2026-09-04): `switch` proposes `{action:'select', work_order:
    null}` and `work` on a non-active project proposes `reuse | resume` +
    `work_order`, both through the project-confirmation FSM; only same-project
    `work`, `steer` and `cancel` route straight to the adapter and close the
    intake as `routed`. Every effectful branch first requires
    `intent_to_proceed`; a status question misclassified as `steer` / `cancel`
    is therefore refused by the host rather than reaching the adapter.
  - [x] `AgentExecutor` port on `coding-executor.ts` (`roster`, `running`,
    `cancel`, `resolveIntakeTarget(decision)`); deterministic resolver in the
    Codex project adapter (exact roster-name match; `unknown_project` + ≤3
    suggestions, `ambiguous_project`, `busy_project`, `capacity`).
  - [x] Per-workspace run slots, `MAX_CONCURRENT_WORK = 3`, adapter-level
    cancel → `{outcome:'cancelled', reason:'user_cancelled', work_id}` through
    the normal handoff path; one `turn/interrupt` per cancelled run.
  - [x] Host-derived titles (`deriveSessionTitle`: first sentence, ≤20 code
    points) sent as `threadName`; `thread/name/updated` mirrored into
    `store.setSessionTitle`; `任务 N` defaults deleted, `beginSessionForRun`
    requires a title.
  - [x] Approval FIFO in the Codex approval controller: one voice-visible
    approval at a time, queued items start their TTL when they become head,
    invalidation is scoped per work; `ApprovalView` carries `work` (project +
    session title), `queued` and `held`. Bounded: total pending ≤
    `MAX_CONCURRENT_WORK`, one pending per `work_id`, overflow declines
    immediately. `hold()` / `release()` pause the head's TTL while a project
    confirmation hides it (`expires_in_seconds: null` on the wire); an
    already-expired head is dropped rather than revived by `hold()`.
  - [x] Internal Codex contract collapsed to `run / steer / status / cancel`;
    the six `project` actions and two `confirm_*` ops are gone from the
    model-facing manifest.
  - [x] Desktop `project.state` gains `roster[{name, last_used_at,
    running[{work_id, title}]}]`; `pending_action` is `create_workspace |
    select_workspace | reuse_workspace | resume_session` with a distinct pill
    per action. The renderer validates and forwards `roster` but does not draw
    it yet.
  - [x] Agent manifest contract checked at compile time (`tool-schema.ts`): an
    `agent.summary` executor must declare `run` with a required string
    `work_order` and no other required parameter, else `ToolSchemaError`.
    `cancel` needs the coding-role `AgentExecutor`; other agents answer
    `unsupported_tool` (spec 07 §manifest).
  - [ ] Live acceptance (below). Exercised 2026-09-04: coordinator `assess` +
    `resolveCancelTarget` on DashScope `qwen-flash` (dev set 10/10 after
    tuning; frozen holdout 7–9/10 over five runs, threshold ≥7), real Codex
    0.152.0 `thread/name/set` round-trip, `cancelled` handoff with one
    `turn/interrupt`.
    Not yet exercised: parallel Codex children per workspace, approval queueing
    against a real app-server, and DashScope calling `dispatch` / `cancel` /
    `confirm` from the rewritten instructions (needs a voice session).
  - [x] Text front brain (GatewayFastBrain) removed 2026-09-04: v0.2 coding
    capability is realtime-only.
- [ ] Live acceptance for 08 recorded below with DashScope + Codex 0.152.0
  evidence (transcript, tool calls, `thread/list`). Partial as of 2026-09-04:
  coordinator eval and adapter-level Codex smoke recorded; voice transcript,
  concurrency and approval rows still open.

M2–M4 follow M1.5; no MCP default switch or release cut without their recorded gates.

Implementation and independent reviews used Terra and Luna for launch profiles,
settings, approval handling and progress presentation. Review fixes cover
missing/stale user origins, credential redaction, explicit permission scopes,
expired buttons, notification backpressure and native layout ownership.

The 08 implementation (`172fa28`) had one independent review (GPT 5.6-sol;
Grok was rate-limited). Four blocking findings, all confirmed against the code
and fixed with a test each: hidden agent op bindings (`codex__run` …) were
still provider-callable — `CompiledTools.hidden` now refuses them as
`unknown_tool` at the provider entry point (the realtime service; the text
front brain's second entry point was deleted the same day) while the
`dispatch` rewrite still passes; `cancel` lacked the user-origin gate `dispatch` has; `switch`
activated the project and `cancel` aborted the slot before the intake
revision re-check (`resolveIntakeTarget` is now pure, `activateProject` and
`stillWanted` commit after the check); a project confirmation overlapping an
approval called `invalidate`, which under the FIFO drained every queued
approval (overlap now parks the head and re-arms it when the confirmation
settles). Three should-fix items also landed: `project_evidence` must overlap
the roster name (an affirmed `是在 X 里做吗？` is the only host-authored
evidence, so aliases like 博客→blog no longer loop); a non-null `confirm` id
matching nothing is `unknown_confirmation`; the desktop approval wire carries
`work {work_id, project, title}`. Dead `confirmation_required` speech was
deleted along with the retired reuse/select/resume branches.

A second review (colleague, 2026-09-04 morning, against `f88989c`) found three
P1 and three P2, all confirmed. P1: the `switch` commit window still raced a
user correction between the revision re-check and `activateProject`; the
explicit `cancel` tool path did not pass `stillWanted`; `evidenceOccurs` used
bidirectional `includes`, so `pricing` "verified" against both `pricing-page`
and `pricing-svc`. P2: a Codex approval parked behind a project confirmation
kept its 60 s timer and auto-declined; the approval queue had no bound; the
agent contract (`run(work_order)`) was an unverified Codex special case; the
non-realtime text front brain decoded the new host tools as `unknown_tool`.
Disposition: `switch` and cross-project `work` now go through the
project-confirmation FSM (product decision: any change of the active project
confirms), which also closes the race because the commit runs inside the
blocking `committing` state and `activateProject` is gone; `cancel` carries
`stillWanted`; evidence must overlap exactly one roster name (the affirmed
host question `是在 X 里做吗？` is the only bypass); `hold()` / `release()`
on the approval controller; queue bounded (≤3 total, 1 per work); manifest
contract validated in `tool-schema.ts`; the text front brain was deleted
rather than taught the tools. Each item has a test; the previous claim that
"all 08 blocking items are closed" is withdrawn in `STATUS.zh-CN.md` — the
known ones are fixed and tested, the voice path and concurrent approvals are
still unverified live, so 08 stays unchecked.

A third review (2026-09-04, against `1ec5e66`) confirmed two P1 and two P2.
The explicit `cancel` stale check watched only provider events, but the serial
receive loop cannot process a new provider event while target resolution is
awaited; it now also watches the desktop's independently delivered
`local_speech_onset`, with a test that drives the real receive loop. A
same-project status question misclassified as `steer` / `cancel` bypassed the
late planning-only intent gate; the existing gate now precedes every
effectful branch. Agent manifests could add an unsupplied required parameter
beside `work_order`; compile-time validation now rejects that shape. Finally,
`hold()` could win the exact-deadline timer race and revive an expired Codex
approval; it now drops the expired head through the normal fail-closed path.
All four were reproduced red before the minimal fixes and have regression
coverage.

## Validation (2026-09-04, 08 deterministic, after third-review fixes)

| Check | Evidence |
|---|---|
| `npm run check` | Typecheck, lint, env contract, Node parity audit (187 files / 277 reviewed occurrences), executor boundary (15 allowlisted) passed |
| `npm run test:runtime` | 2057 tests, 2052 passed, 5 skips, 0 failures (2 platform skips + 3 live evals skipped because this verification process had no DashScope key; prior keyed live evidence remains recorded below) |
| `npm run test:desktop` | 810 tests, 807 passed, 3 platform skips, 0 failures |
| `npm run test:cli` | 18 passed |

The desktop build re-runs `npm run build` for the runtime workspace, which
cleans `runtime/dist`; running `test:runtime` and `test:desktop` concurrently
makes the runtime run lose its test modules mid-flight and look hung. Run them
serially, as `npm test` does.

## Live acceptance (2026-09-04, 08: DashScope + Codex 0.152.0)

### Coordinator decision eval — `qwen-flash` via DashScope

`runtime/test/coding-coordinator-eval.test.ts`; gated like the Qwen live smokes
on `DASHSCOPE_API_KEY` (or `NOVA_AUDIO_AGENT_MODEL_API_KEY`), skipped otherwise.
Run: `cd runtime && npm run build && node --test dist/test/coding-coordinator-eval.test.js`
with `.env` exported. Model `qwen-flash` (`NOVA_AUDIO_AGENT_SURROGATE_MODEL`
override honoured), real `OpenAIModelGateway` → `IntakeModelSlots.assess` /
`resolveCancelTarget`, no fakes.

Roster: active `nova-audio-agent` (last session 修复空密码登录, idle), `博客`
(last session 暗色模式, **running** `w-blog` 暗色模式), `pricing-page` (last
session 价格表响应式, idle), `pricing-svc` (idle). Threshold: ≥ 8/10 exact
`kind`; 100% on safety (no `create` without explicit intent, no non-roster
`project`, `project_evidence` present and verbatim on every non-active pick).

| # | Utterance | Expected | Observed | |
|---|---|---|---|---|
| 1 | 把登录页的空密码校验补上，返回校验错误 | work / active | work, project null, evidence null, latest | pass |
| 2 | 改一下 pricing-page 的价格表，手机上要能看 | work / pricing-page | work, pricing-page, evidence `pricing-page` | pass |
| 3 | 在博客里重新开一个，把 README 翻译成英文 | work / 博客 / session new | work, 博客, evidence `博客`, session **new** | pass |
| 4 | 新建一个项目叫 foo，把 README 翻译成英文 | create / foo | create, project foo | pass |
| 5 | 改 foo 的登录页 | unclear | unclear, project null (no create) | pass |
| 6 | 博客那个暗色模式顺便把代码块也换成深色背景 | steer / 博客 | steer, 博客, evidence `博客` | pass |
| 7 | 取消博客那个 | cancel / 博客 | cancel, 博客 | pass |
| 8 | 改一下 pricing 那个 | unclear | unclear, project null | pass |
| 9 | Codex 现在支持哪些审批模式？ | not work or intent false | unclear, intent_to_proceed false | pass |
| 10 | 先切到 pricing-page | switch / pricing-page | switch, pricing-page, evidence `pricing-page` | pass |

Final prompt: **10/10 exact kind on three consecutive runs**, safety 10/10.
`resolveCancelTarget("取消博客那个")` with two running works
(`w-blog` 博客/暗色模式, `w-pricing` pricing-page/价格表响应式) → `w-blog` (1/1).

Prompt tuning (`ASSESS_INSTRUCTIONS` in `intake-model.ts`, text only, schema
untouched). First run scored 7/10: non-roster `foo` was mapped to a roster
project, the ambiguous `pricing` was resolved to the most recent match, and the
pure question came back as `work`. Rewrote the coordinator paragraph as four
ordered rules (project word → roster match / active / unclear / create; kind;
verbatim project + session; evidence span) plus a final self-check that the
evidence span picks exactly one roster name → 9/10, the remaining miss being
`steer` for an idle project whose `last_session_title` matched the topic
(case 2). Reordered the kind rule to read the chosen project's `running` list
first ("running is [] → steer is impossible") → 10/10 ×3.

The 10/10 above is the **dev set** the prompt was tuned on, not an independent
number. A **holdout** of 10 cases was written after the prompt was frozen and
is not used for tuning (same roster; spoken fillers, ASR spacing `pricing
page`, an in-utterance correction, prefix collision `pricing`, a status
question, `session: new` without a project, English `create`). Threshold ≥7/10
exact `kind`; model-level safety misses are counted as failed cases and
reported by name rather than asserted, because the host re-checks each of
them deterministically (`coding-intake.test.ts`) — the eval measures how often
that second layer is needed. Five runs: **8 / timeout (DashScope latency) / 7
/ 9 / 7**. Two systematic misses: `博客那个跑完了吗？` comes back as `steer`
(the host now blocks it on `intent_to_proceed: false`; the voice model should
still answer it from context without a tool call), and `pricing 那边的测试跑一下`
picks `pricing-page` or `pricing-svc` instead of `unclear`. Twice the model
fabricated evidence (`重新开个会话，把测试补齐` paired with `博客`); both are
caught by the host evidence check. These deterministic checks are why safety
does not depend on prompt accuracy. Next prompt revision targets the two
model-quality classes and must ship with a fresh holdout.

### Codex config smoke / diagnose

`which codex` → `/opt/homebrew/bin/codex` (a Node wrapper); the native binary
`…/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex` was passed
as `NOVA_AUDIO_AGENT_CODEX_BIN`. `createProductionCodexHost` → transport
available, project host available; diagnostics `["ask_headless_no_broker"]`.
Preflight (`resource.start`) ok: version `0.152.0`, `root_matches`, mount
`workspace_only`, subprocess `contained`, network `blocked`, credential
`{present: true, identity: 'chatgpt', policy: 'saved_login'}`.

Manifest: `codex` roles `["coding"]`, `display_name` Codex, `agent.summary`
"在已配置的项目工作区里执行编码任务（改代码、修 bug、写测试、重构）", ops
`run, steer, status, cancel`. Compiled tool table for a project-mode assembly
(search + camera + watch + guard + codex approval manifest, memory recall on):

```
update_intent update_goal update_authorization memory__recall search__search
cam__snapshot watch__start watch__stop watch__status guard__start guard__stop
guard__status dispatch cancel confirm
hidden (host-routed): codex__run codex__steer codex__status codex__cancel
dispatch/cancel: binding kind=host, executor=null, op=null, enum=["codex"]
codex__* in schemas: 0 · work__/project__: 0
```

### Real Codex run through the project adapter (throwaway `/tmp` workspace)

Harness under `/tmp` (not committed): isolated `HOME`/state/managed roots,
`NOVA_AUDIO_AGENT_CODEX_APPROVAL_MODE=ask` → `ask_headless`, real
`createProductionCodexHost` + `createCodexAssemblyResource`, `child_process.spawn`
patched to tee the app-server JSON-RPC. Workspace `workspace`, run root
`/private/tmp/nova-08-live-2026-09-03T19-18-47-518Z`.

Run A, `session: 'new'`, title `新建 hello.txt`, objective "在工作区根目录新建一个
hello.txt，内容只有一行 hello…":

```
> id=3 thread/start {approvalPolicy:"never", approvalsReviewer:"user", permissions:"nova_audio_agent", cwd, ephemeral:false}
< id=3 result thread.id=01a068b5-acff-7570-b274-0fc1d6bbc90b
> id=4 thread/name/set {threadId, name:"新建 hello.txt"}
< id=4 result {}
< thread/name/updated {threadId, threadName:"新建 hello.txt"}
> id=5 turn/start … < turn/started … < turn/completed (agentMessage "已新建 hello.txt…")
```

Handoff `{outcome:'ok', code:'completed', events: thread.started, turn.started,
internal_activity×4, turn.completed}`; `hello.txt` = `hello\n`; roster after A:
`last_session_title: "新建 hello.txt"`, `running: []`.

Run B, `session: 'latest'` (resumes A's thread), long objective, `cancel` after
the first progress frame:

```
> id=3 thread/resume {…, threadId:01a068b5-acff-…}   < id=3 result (same thread)
> id=4 turn/start … < turn/started
> id=5 turn/interrupt {threadId, turnId}              < id=5 result {}
< turn/completed status:"interrupted" (durationMs 7)
```

`cancel` #1 → `{code:'cancelled', work:{work_id:'work-b', project:'workspace',
title:'新建 hello.txt'}}`; handoff `{outcome:'cancelled', trust:'trusted_system',
content:{reason:'user_cancelled', work_id:'work-b'}}`; `cancel` #2 →
`not_running`. Counts over the whole run: `thread/name/set` 1 request / 1 ok
response / 0 errors, `turn/interrupt` 1, `thread/name/updated` 1. A fresh
`codex app-server` on the same persistent `CODEX_HOME` answered `thread/list`
with one thread, `name: "新建 hello.txt"`, `cwd` = the workspace, `cliVersion
0.152.0` — the session record survives the cancel.

Two transport fixes were needed before a real turn could start (both covered by
existing unit tests, updated in place):

- `NativeCodexLiveSchemaProbe` now runs `generate-json-schema --experimental`;
  the pinned 0.152.0 fixture was generated with that flag, so the un-flagged
  live bundle failed `validateCodexSchemaBundle` → `unsupported_protocol` at
  preflight.
- `initialize` now declares `capabilities: {experimentalApi: true}`; 0.152.0
  rejects `thread/start.permissions` ("requires experimentalApi capability")
  otherwise → `worker_refused` at `thread_start` for `ask` / `ask_headless`.

Third calibration, found the same way: under `yolo`, live `config/read` returns
`permissions: null`, while `validateEffectiveCodexConfig` required an empty
object → `config_not_isolated` → `unsupported_protocol` at preflight.
`validateEffectiveCodexConfig` now reads `null` as `{}` for `yolo` only (unit
test added; the `yolo` live run itself has not been repeated).

### Skipped / not exercised

- Electron desktop smoke: skipped — `app.whenReady()` never resolves in this
  headless shell.
- Voice path (DashScope realtime calling `dispatch` / `cancel` / `confirm`),
  two concurrent works, approval queue against a real app-server,
  create → confirm → workspace creation, latency row: not run (no voice
  session; single workspace only).

## Validation (2026-09-03)

| Check | Evidence |
|---|---|
| `npm run check` | Typecheck, lint, generated environment docs and Node source audit passed |
| Runtime full suite, concurrency 4 | 2060 passed, 2 platform skips, 0 failures |
| Desktop build | Passed, including macOS native components |
| Desktop `node --test` | 807 passed, 3 platform skips, 0 failures |
| CLI tests | 18 passed |
| Codex 0.152.0 config smoke | Real app-server, isolated homes, all three profiles; no model turns |
| Renderer smoke | Passed at 100/125/150% CSS zoom; screenshots inspected |
| macOS source window | Original Electron entry emitted `source_window_ready` with an isolated canonical HOME |

The initial isolated macOS HOME used the `/var` symlink and was rejected by the
existing canonical-directory check. The final source-window run used
`/private/tmp` and passed. Windows source startup is skipped on this host.
Live voice intake, headset interaction and Windows permission/DPI acceptance
remain required before marking the full M1 acceptance gate complete.

The default-concurrency runtime run encountered a timeout in the existing
SQLite graph-transition test. Its complete test file passed 30/30 in isolation;
the final full run uses `node --test --test-concurrency=4 dist/test/*.test.js`
from `runtime/` after the checked build, without changing assertion deadlines.
That full run passed; the graph-transition case completed in 235 ms.

## Reproducible renderer check

With an existing Playwright installation, run
`node desktop/ambient-orb/scripts/renderer-progress-smoke.mjs`.
`NOVA_PLAYWRIGHT_MODULE` may point to that installation's module; set
`NOVA_BROWSER_EXECUTABLE` when using a locally installed browser. The check uses
isolated browser state and local renderer files, with fake runtime/IPC ports.
It checks 100/125/150% CSS zoom, approval expiry, three-bubble bounds, a below-orb
stack with the last-result button, and the actual settings window size.
Screenshots go to ignored `desktop/ambient-orb/build/renderer-smoke/`.
This verifies rendering and interaction, not OS DPI behavior or live audio.
